import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import * as vscode from 'vscode';

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_READ_BYTES = 200_000;
const MAX_SEARCH_RESULTS = 30;

/**
 * Sanitize a workspace-relative path to prevent directory traversal.
 * Returns undefined if the resolved path escapes the workspace root.
 */
function safePath(rootPath: string, relativePath: string): string | undefined {
  // Normalize to prevent double-dot traversal
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.resolve(rootPath, normalized);
  if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) {
    return undefined;
  }
  return resolved;
}

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
  rootPath: string,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'readFile': return await readFile(input, rootPath);
      case 'editFile': return await editFile(input, rootPath);
      case 'writeFile': return await writeFile(input, rootPath);
      case 'listFiles': return await listFiles(input, rootPath);
      case 'searchText': return await searchText(input, rootPath);
      case 'getDiagnostics': return await getDiagnostics(input, rootPath);
      case 'runCommand': return await runCommand(input, rootPath);
      case 'sendAgentMessage': return sendAgentMessage(input);
      default: return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      content: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function readFile(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const filePath = String(input.path ?? '');
  if (!filePath) { return { content: 'Missing required parameter: path', isError: true }; }
  const abs = safePath(rootPath, filePath);
  if (!abs) { return { content: 'Path escapes workspace root.', isError: true }; }

  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) { return { content: `File not found: ${filePath}`, isError: true }; }

  const rawContent = await fs.promises.readFile(abs, 'utf-8');
  const lines = rawContent.split('\n');
  const totalLines = lines.length;

  const startLine = typeof input.startLine === 'number' ? Math.max(1, Math.floor(input.startLine)) : 1;
  const endLine = typeof input.endLine === 'number' ? Math.min(totalLines, Math.floor(input.endLine)) : totalLines;

  if (startLine > totalLines) {
    return { content: `File has ${totalLines} lines; startLine ${startLine} is out of range.`, isError: true };
  }

  const slice = lines.slice(startLine - 1, endLine);
  const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');

  const header = `File: ${filePath} (${totalLines} lines total, showing ${startLine}-${Math.min(endLine, totalLines)})\n`;

  const content = header + numbered;
  if (content.length > MAX_READ_BYTES) {
    return { content: content.slice(0, MAX_READ_BYTES) + '\n... (truncated)' };
  }
  return { content };
}

async function editFile(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const filePath = String(input.path ?? '');
  const oldString = String(input.oldString ?? '');
  const newString = String(input.newString ?? '');
  if (!filePath) { return { content: 'Missing required parameter: path', isError: true }; }
  if (!oldString) { return { content: 'Missing required parameter: oldString', isError: true }; }
  const abs = safePath(rootPath, filePath);
  if (!abs) { return { content: 'Path escapes workspace root.', isError: true }; }

  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) { return { content: `File not found: ${filePath}`, isError: true }; }

  const content = await fs.promises.readFile(abs, 'utf-8');

  // Count occurrences to ensure exactly one match
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(oldString, idx)) !== -1) {
    count++;
    idx += oldString.length;
  }

  if (count === 0) {
    return { content: `oldString not found in ${filePath}. Verify the exact text (including whitespace and indentation).`, isError: true };
  }
  if (count > 1) {
    return { content: `oldString matched ${count} locations in ${filePath}. Include more surrounding context to match exactly once.`, isError: true };
  }

  const updated = content.replace(oldString, newString);
  await fs.promises.writeFile(abs, updated, 'utf-8');
  return { content: `Edited ${filePath}: replaced ${oldString.length} chars with ${newString.length} chars.` };
}

async function writeFile(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const filePath = String(input.path ?? '');
  const content = String(input.content ?? '');
  if (!filePath) { return { content: 'Missing required parameter: path', isError: true }; }
  const abs = safePath(rootPath, filePath);
  if (!abs) { return { content: 'Path escapes workspace root.', isError: true }; }

  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, 'utf-8');
  return { content: `Wrote ${content.length} chars to ${filePath}` };
}

async function listFiles(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const dirPath = String(input.path ?? '.');
  const pattern = input.pattern ? String(input.pattern) : undefined;
  const abs = safePath(rootPath, dirPath);
  if (!abs) { return { content: 'Path escapes workspace root.', isError: true }; }

  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) { return { content: `Not a directory: ${dirPath}`, isError: true }; }

  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  let names = entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name);
  if (pattern) {
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    names = names.filter((n) => regex.test(n.replace(/\/$/, '')));
  }
  return { content: names.join('\n') || '(empty directory)' };
}

async function searchText(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const pattern = String(input.pattern ?? '');
  if (!pattern) { return { content: 'Missing required parameter: pattern', isError: true }; }
  const include = input.include ? String(input.include) : '**/*';

  const results: string[] = [];
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootPath, include),
    '**/node_modules/**',
    100,
  );

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch {
    return { content: `Invalid regex pattern: ${pattern}`, isError: true };
  }

  for (const uri of files) {
    if (results.length >= MAX_SEARCH_RESULTS) { break; }
    try {
      const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const relativePath = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
          results.push(`${relativePath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= MAX_SEARCH_RESULTS) { break; }
        }
        regex.lastIndex = 0;
      }
    } catch { /* skip unreadable files */ }
  }

  return { content: results.join('\n') || 'No matches found.' };
}

async function getDiagnostics(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const filePath = input.path ? String(input.path) : undefined;

  let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];
  if (filePath) {
    const abs = safePath(rootPath, filePath);
    if (!abs) { return { content: 'Path escapes workspace root.', isError: true }; }
    const uri = vscode.Uri.file(abs);
    const fileDiags = vscode.languages.getDiagnostics(uri);
    diagnostics = fileDiags.length > 0 ? [[uri, fileDiags]] : [];
  } else {
    diagnostics = vscode.languages.getDiagnostics()
      .filter(([uri, diags]) => diags.length > 0 && uri.fsPath.startsWith(rootPath));
  }

  if (diagnostics.length === 0) {
    return { content: filePath ? `No diagnostics for ${filePath}.` : 'No diagnostics found in workspace.' };
  }

  const lines: string[] = [];
  const severityLabel = ['Error', 'Warning', 'Info', 'Hint'];
  for (const [uri, diags] of diagnostics) {
    const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; } // skip info/hints
      const sev = severityLabel[d.severity] ?? 'Unknown';
      const line = d.range.start.line + 1;
      const src = d.source ? ` [${d.source}]` : '';
      lines.push(`${rel}:${line}: ${sev}${src}: ${d.message}`);
    }
  }

  return { content: lines.join('\n') || 'No errors or warnings.' };
}

async function runCommand(input: Record<string, unknown>, rootPath: string): Promise<ToolResult> {
  const command = String(input.command ?? '');
  if (!command) { return { content: 'No command provided.', isError: true }; }

  // Block known-dangerous patterns
  const blocked = /\b(rm\s+-rf\s+[/\\]|format\s+[a-z]:|del\s+\/[sq]|shutdown|reboot|mkfs)\b/i;
  if (blocked.test(command)) {
    return { content: 'Command blocked for safety.', isError: true };
  }

  return new Promise<ToolResult>((resolve) => {
    exec(command, {
      cwd: rootPath,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    }, (error, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (error && !stdout) {
        resolve({ content: out || error.message, isError: true });
      } else {
        resolve({ content: out || '(no output)' });
      }
    });
  });
}

function sendAgentMessage(input: Record<string, unknown>): ToolResult {
  const toAgentId = String(input.toAgentId ?? '');
  const content = String(input.content ?? '');
  if (!toAgentId || !content) {
    return { content: 'Missing toAgentId or content.', isError: true };
  }
  return { content: `Message queued for agent ${toAgentId}.` };
}
