import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import type { WorkspaceContext, WorkspaceFileContext } from '../../shared/model/index.js';

const execFileAsync = promisify(execFile);

const FILE_GLOB = '**/*.{ts,tsx,js,jsx,json,md,css,scss,html,mjs,cjs,yml,yaml,py,go,rs,java,c,cpp,h,hpp,cs,rb,php,sh,ps1,toml,ini,env}';
const EXCLUDE_GLOB = '**/{node_modules,dist,.git,.pixel-squad,out,coverage,__pycache__,.venv,target,bin,obj}/**';
const MAX_FILES = 4;
const SYMBOLS_TIMEOUT_MS = 800;
const BUDGET_CHARS = 120_000;
const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> { value: T; ts: number; }

export class WorkspaceContextService {
  private gitCache = new Map<string, CacheEntry<string>>();
  private fileListCache: CacheEntry<vscode.Uri[]> | undefined;

  constructor(private readonly rootPath: string | undefined) {}

  /**
   * Lightweight snapshot: grabs only editor state and cached git info.
   * Returns immediately without blocking the extension host.
   */
  captureLightweight(): WorkspaceContext {
    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = this.toRelativePath(activeEditor?.document.uri.fsPath);
    const selectedText = activeEditor && !activeEditor.selection.isEmpty
      ? activeEditor.document.getText(activeEditor.selection).slice(0, 1600)
      : undefined;

    return {
      workspaceRoot: this.rootPath,
      branch: this.getCached('branch'),
      gitStatus: this.getCached('status')?.split(/\r?\n/).filter(Boolean).slice(0, 20),
      activeFile,
      selectedText,
      contextMode: 'light',
      relevantFiles: [],
    };
  }

  /**
   * Full async capture: git calls, file discovery, snippet reading.
   * When a model is provided, uses `countTokens()` + `maxInputTokens` to
   * fill the context window dynamically — no arbitrary line caps.
   */
  async capture(
    prompt: string,
    maxFiles = MAX_FILES,
    extraPinnedFiles?: string[],
    _model?: vscode.LanguageModelChat,
  ): Promise<WorkspaceContext> {
    try {
      const activeEditor = vscode.window.activeTextEditor;
      const activeFile = this.toRelativePath(activeEditor?.document.uri.fsPath);
      const selectedText = activeEditor && !activeEditor.selection.isEmpty
        ? activeEditor.document.getText(activeEditor.selection).slice(0, 1600)
        : undefined;

      const [branch, gitStatus, relevantFiles] = await Promise.all([
        this.safeGitAsync(['branch', '--show-current']),
        this.safeGitAsync(['status', '--short', '--branch']),
        this.rootPath
          ? this.collectRelevantFiles(prompt, activeEditor?.document.uri.fsPath, maxFiles)
          : Promise.resolve([]),
      ]);

      // Merge pinned files (priority) with auto-selected files, then apply budget
      const pinnedContextFiles = this.readPinnedFiles(extraPinnedFiles);
      // Pinned files come first so they survive budget trimming
      const merged = [
        ...pinnedContextFiles,
        ...relevantFiles.filter((f) => !new Set(pinnedContextFiles.map((p) => p.path)).has(f.path)),
      ];
      const budgeted = this.applyCharBudget(merged);

      return {
        workspaceRoot: this.rootPath,
        branch: branch || undefined,
        gitStatus: gitStatus ? gitStatus.split(/\r?\n/).filter(Boolean).slice(0, 20) : undefined,
        activeFile,
        selectedText,
        contextMode: 'full',
        relevantFiles: budgeted,
      };
    } catch {
      // Any error during workspace context capture falls back to lightweight snapshot
      // so a malformed URI or missing provider never surfaces as a routing failure.
      return this.captureLightweight();
    }
  }

  /** List workspace-relative paths for the file picker. */
  async listWorkspaceFiles(): Promise<string[]> {
    const uris = await this.findFilesCached();
    return uris
      .map((uri) => this.toRelativePath(uri.fsPath))
      .filter((p): p is string => Boolean(p))
      .sort();
  }

  private readPinnedFiles(filePaths?: string[]): WorkspaceFileContext[] {
    if (!filePaths || filePaths.length === 0 || !this.rootPath) {
      return [];
    }
    return filePaths
      .map((relativePath) => {
        const absolute = path.resolve(this.rootPath!, relativePath);
        if (!absolute.startsWith(path.resolve(this.rootPath!)) || !fs.existsSync(absolute)) {
          return undefined;
        }
        return {
          path: relativePath,
          reason: 'Pinned to agent by user.',
          content: this.readFileContent(absolute),
        };
      })
      .filter((entry): entry is WorkspaceFileContext => Boolean(entry));
  }

  private async collectRelevantFiles(prompt: string, activeFsPath?: string, maxFiles = MAX_FILES): Promise<WorkspaceFileContext[]> {
    const keywordTokens = prompt.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);

    // Run git status, workspace symbol search, and file list in parallel
    const [statusRaw, symbolHitPaths, uris] = await Promise.all([
      this.safeGitAsync(['status', '--short']),
      this.searchWorkspaceSymbols(keywordTokens),
      this.findFilesCached(),
    ]);

    const changedFiles = new Set(statusRaw.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/\\/g, '/')));
    const openTabs = new Set(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => ('input' in tab && tab.input != null ? (tab.input as { uri?: vscode.Uri }).uri?.fsPath : undefined))
        .filter((value): value is string => Boolean(value))
        .map((value) => this.toRelativePath(value))
        .filter((value): value is string => Boolean(value)),
    );

    const scored = uris
      .map((uri) => {
        const relativePath = this.toRelativePath(uri.fsPath);
        if (!relativePath) {
          return undefined;
        }

        let score = 0;
        let reason = 'Matched workspace context.';
        const lowerPath = relativePath.toLowerCase();
        if (activeFsPath && path.resolve(activeFsPath) === path.resolve(uri.fsPath)) {
          score += 100;
          reason = 'Currently active file in the editor.';
        }
        if (openTabs.has(relativePath)) {
          score += 40;
          reason = 'File is currently open in an editor tab.';
        }
        if (changedFiles.has(relativePath)) {
          score += 35;
          reason = 'File has local git changes.';
        }
        // Symbol index hit — VS Code language extensions confirmed this file
        // contains a function/class/type that matches a keyword from the task
        if (symbolHitPaths.has(relativePath)) {
          score += 60;
          reason = 'Contains symbols matching the task prompt.';
        }
        for (const token of keywordTokens) {
          if (lowerPath.includes(token)) {
            score += 10;
            reason = `Path matched prompt keyword "${token}".`;
          }
        }
        if (lowerPath.includes('readme') || lowerPath.includes('package') || lowerPath.includes('extension')) {
          score += 3;
        }

        return { uri, relativePath, score, reason };
      })
      .filter((entry): entry is { uri: vscode.Uri; relativePath: string; score: number; reason: string } => Boolean(entry))
      .sort((left, right) => right.score - left.score)
      .slice(0, maxFiles);

    // Expand: walk import graph of top-ranked files to pull in cross-file dependencies
    // e.g. if Coordinator.ts is top-ranked, its imports (WorkspaceContextService, TaskScheduler) come along
    const importExtras = this.collectImportedFiles(scored.map((e) => e.uri.fsPath));
    const alreadyIncluded = new Set(scored.map((e) => e.relativePath));

    return [
      ...scored.map((entry) => ({
        path: entry.relativePath,
        reason: entry.reason,
        content: this.readFileContent(entry.uri.fsPath),
      })),
      ...importExtras
        .filter((rel) => !alreadyIncluded.has(rel))
        .slice(0, 2)
        .map((rel) => ({
          path: rel,
          reason: 'Referenced via import from a relevant file.',
          content: this.readFileContent(path.resolve(this.rootPath!, rel)),
        })),
    ];
  }

  /**
   * Query VS Code's workspace symbol index using task keywords.
   * Language extensions (TypeScript, Pylance, etc.) register symbol providers
   * that search actual function/class/type definitions — the same mechanism
   * powering Go-to-Symbol and @workspace in Copilot Chat.
   */
  private async searchWorkspaceSymbols(tokens: string[]): Promise<Set<string>> {
    const hitPaths = new Set<string>();
    if (!this.rootPath) { return hitPaths; }
    // Use tokens of 4+ chars — more likely to be real identifiers; cap at 4 to keep latency low
    const candidateTokens = tokens.filter((t) => t.length >= 4).slice(0, 2);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SYMBOLS_TIMEOUT_MS));
    await Promise.race([
      Promise.all(
        candidateTokens.map(async (token) => {
          try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
              'vscode.executeWorkspaceSymbolProvider',
              token,
            );
            for (const sym of symbols ?? []) {
              const fsPath = sym?.location?.uri?.fsPath;
              const rel = fsPath ? this.toRelativePath(fsPath) : undefined;
              if (rel) { hitPaths.add(rel); }
            }
          } catch { /* provider not available */ }
        }),
      ),
      timeout,
    ]);
    return hitPaths;
  }

  /**
   * Walk import/require statements in the given source files and return the
   * workspace-relative paths they reference. Relative imports only — this
   * mirrors how an IDE resolves cross-file dependencies automatically.
   */
  private collectImportedFiles(fsPaths: string[]): string[] {
    if (!this.rootPath) { return []; }
    const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;
    const REQUIRE_RE = /require\s*\(['"]([^'"]+)['"]\)/g;
    const imported = new Set<string>();

    for (const fsPath of fsPaths) {
      let content: string;
      try { content = fs.readFileSync(fsPath, 'utf8'); } catch { continue; }
      const dir = path.dirname(fsPath);

      for (const re of [IMPORT_RE, REQUIRE_RE]) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
          const spec = match[1];
          if (!spec.startsWith('.')) { continue; } // skip node_modules
          // Try resolving with common TypeScript extensions
          const base = path.resolve(dir, spec.replace(/\.js$/, ''));
          for (const ext of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']) {
            const candidate = base + ext;
            if (fs.existsSync(candidate)) {
              // Security: ensure resolved path is within workspace root
              const resolved = path.resolve(candidate);
              if (!resolved.startsWith(path.resolve(this.rootPath!))) { break; }
              const rel = this.toRelativePath(candidate);
              if (rel) { imported.add(rel); }
              break;
            }
          }
        }
      }
    }
    return [...imported];
  }

  private async findFilesCached(): Promise<vscode.Uri[]> {
    if (this.fileListCache && Date.now() - this.fileListCache.ts < CACHE_TTL_MS) {
      return this.fileListCache.value;
    }
    const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, 80);
    this.fileListCache = { value: uris, ts: Date.now() };
    return uris;
  }

  /** Read entire file content. */
  private readFileContent(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private applyCharBudget(files: WorkspaceFileContext[]): WorkspaceFileContext[] {
    const result: WorkspaceFileContext[] = [];
    let used = 0;
    for (const file of files) {
      const chars = file.content.length + file.path.length + (file.reason?.length ?? 0) + 30;
      if (used + chars > BUDGET_CHARS && result.length > 0) {
        break;
      }
      result.push(file);
      used += chars;
    }
    return result;
  }

  private getCached(key: string): string | undefined {
    const entry = this.gitCache.get(key);
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
      return entry.value;
    }
    return undefined;
  }

  private async safeGitAsync(args: string[]): Promise<string> {
    if (!this.rootPath) {
      return '';
    }
    const cacheKey = args.join(' ');
    const cached = this.getCached(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.rootPath,
        encoding: 'utf8',
        windowsHide: true,
      });
      const result = stdout.trim();
      this.gitCache.set(cacheKey, { value: result, ts: Date.now() });
      return result;
    } catch {
      this.gitCache.set(cacheKey, { value: '', ts: Date.now() });
      return '';
    }
  }

  private toRelativePath(filePath: string | undefined): string | undefined {
    if (!filePath || !this.rootPath) {
      return undefined;
    }

    const relativePath = path.relative(this.rootPath, filePath);
    return relativePath.startsWith('..') ? undefined : relativePath.replace(/\\/g, '/');
  }
}
