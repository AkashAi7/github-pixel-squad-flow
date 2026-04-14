import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import type { WorkspaceContext, WorkspaceFileContext } from '../../shared/model/index.js';

const execFileAsync = promisify(execFile);

const FILE_GLOB = '**/*.{ts,tsx,js,jsx,json,md,css,scss,html,mjs,cjs,yml,yaml}';
const EXCLUDE_GLOB = '**/{node_modules,dist,.git,.pixel-squad,out,coverage}/**';
const MAX_FILES = 6;
const MAX_LINES = 120;
const CACHE_TTL_MS = 8_000;

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
      relevantFiles: [],
    };
  }

  /**
   * Full async capture: git calls, file discovery, snippet reading.
   * All I/O is non-blocking.
   */
  async capture(prompt: string, maxFiles = MAX_FILES): Promise<WorkspaceContext> {
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

    return {
      workspaceRoot: this.rootPath,
      branch: branch || undefined,
      gitStatus: gitStatus ? gitStatus.split(/\r?\n/).filter(Boolean).slice(0, 20) : undefined,
      activeFile,
      selectedText,
      relevantFiles,
    };
  }

  private async collectRelevantFiles(prompt: string, activeFsPath?: string, maxFiles = MAX_FILES): Promise<WorkspaceFileContext[]> {
    const keywordTokens = prompt.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    const statusRaw = await this.safeGitAsync(['status', '--short']);
    const changedFiles = new Set(statusRaw.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/\\/g, '/')));
    const openTabs = new Set(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => ('input' in tab ? (tab.input as { uri?: vscode.Uri }).uri?.fsPath : undefined))
        .filter((value): value is string => Boolean(value))
        .map((value) => this.toRelativePath(value))
        .filter((value): value is string => Boolean(value)),
    );
    const uris = await this.findFilesCached();
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

    return scored.map((entry) => ({
      path: entry.relativePath,
      reason: entry.reason,
      content: this.readSnippet(entry.uri.fsPath),
    }));
  }

  private async findFilesCached(): Promise<vscode.Uri[]> {
    if (this.fileListCache && Date.now() - this.fileListCache.ts < CACHE_TTL_MS) {
      return this.fileListCache.value;
    }
    const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, 80);
    this.fileListCache = { value: uris, ts: Date.now() };
    return uris;
  }

  private readSnippet(filePath: string): string {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return raw.split(/\r?\n/).slice(0, MAX_LINES).join('\n');
    } catch {
      return '';
    }
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
