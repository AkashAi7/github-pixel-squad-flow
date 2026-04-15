import type * as vscode from 'vscode';

/**
 * Workspace tools available to Pixel Squad agents during task execution.
 * These turn agents from "JSON plan generators" into real tool-calling agents
 * that can read, write, search, and run commands in the workspace.
 */
export const WORKSPACE_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'readFile',
    description: 'Read the text content of a file in the workspace. Supports optional line range for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path (e.g. "src/index.ts")' },
        startLine: { type: 'number', description: 'Optional 1-based start line (inclusive). Omit to read from the beginning.' },
        endLine: { type: 'number', description: 'Optional 1-based end line (inclusive). Omit to read to the end.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'editFile',
    description: 'Make a targeted edit to an existing file by replacing an exact string with a new string. Use this instead of writeFile when modifying existing files — it preserves the rest of the file and is safer for large files. The oldString must match exactly one location in the file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        oldString: { type: 'string', description: 'The exact text to find and replace (must match exactly once in the file)' },
        newString: { type: 'string', description: 'The replacement text' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'writeFile',
    description: 'Create a new file or overwrite a small file entirely. For modifying existing files, prefer editFile instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'listFiles',
    description: 'List files and directories at a given path in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path. Use "." for root.' },
        pattern: { type: 'string', description: 'Optional glob filter (e.g. "*.ts")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'searchText',
    description: 'Search for a regex pattern across workspace files. Returns matching file paths and lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        include: { type: 'string', description: 'Glob pattern for files to include (e.g. "**/*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'getDiagnostics',
    description: 'Get compile errors, lint warnings, and other diagnostics for a file or all files in the workspace. Use this after making edits to verify correctness.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path. Omit to get diagnostics for all files with problems.' },
      },
    },
  },
  {
    name: 'runCommand',
    description: 'Run a shell command in the workspace root directory. Returns stdout and stderr. Suitable for builds, tests, installs.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'sendAgentMessage',
    description: 'Send a coordination message to another agent in your room.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string', description: 'ID of the target agent' },
        content: { type: 'string', description: 'Message to send' },
      },
      required: ['toAgentId', 'content'],
    },
  },
];
