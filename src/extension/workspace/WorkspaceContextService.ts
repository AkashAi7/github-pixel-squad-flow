import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';

import type { WorkspaceContext, WorkspaceFileContext } from '../../shared/model/index.js';

const FILE_GLOB = '**/*.{ts,tsx,js,jsx,json,md,css,scss,html,mjs,cjs,yml,yaml}';
const EXCLUDE_GLOB = '**/{node_modules,dist,.git,.pixel-squad,out,coverage}/**';
const MAX_FILES = 6;
const MAX_LINES = 120;

export class WorkspaceContextService {
  constructor(private readonly rootPath: string | undefined) {}

  async capture(prompt: string, maxFiles = MAX_FILES): Promise<WorkspaceContext> {
    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = this.toRelativePath(activeEditor?.document.uri.fsPath);
    const selectedText = activeEditor && !activeEditor.selection.isEmpty
      ? activeEditor.document.getText(activeEditor.selection).slice(0, 1600)
      : undefined;

    const relevantFiles = this.rootPath
      ? await this.collectRelevantFiles(prompt, activeEditor?.document.uri.fsPath, maxFiles)
      : [];

    return {
      workspaceRoot: this.rootPath,
      branch: this.rootPath ? this.safeGit(['branch', '--show-current']) : undefined,
      gitStatus: this.rootPath ? this.safeGit(['status', '--short', '--branch']).split(/\r?\n/).filter(Boolean).slice(0, 20) : undefined,
      activeFile,
      selectedText,
      relevantFiles,
    };
  }

  private async collectRelevantFiles(prompt: string, activeFsPath?: string, maxFiles = MAX_FILES): Promise<WorkspaceFileContext[]> {
    const keywordTokens = prompt.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    const changedFiles = new Set(this.safeGit(['status', '--short']).split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/\\/g, '/')));
    const openTabs = new Set(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => ('input' in tab ? (tab.input as { uri?: vscode.Uri }).uri?.fsPath : undefined))
        .filter((value): value is string => Boolean(value))
        .map((value) => this.toRelativePath(value))
        .filter((value): value is string => Boolean(value)),
    );
    const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, 80);
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

  private readSnippet(filePath: string): string {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return raw.split(/\r?\n/).slice(0, MAX_LINES).join('\n');
    } catch {
      return '';
    }
  }

  private safeGit(args: string[]): string {
    if (!this.rootPath) {
      return '';
    }

    try {
      return execFileSync('git', args, {
        cwd: this.rootPath,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    } catch {
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
