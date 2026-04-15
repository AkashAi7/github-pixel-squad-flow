import type * as vscode from 'vscode';

/**
 * Workspace tools available to Pixel Squad agents during task execution.
 * These turn agents from "JSON plan generators" into real tool-calling agents
 * that can read, write, search, and run commands in the workspace.
 */
export const WORKSPACE_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'readFile',
    description: 'Read the full text content of a file in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path (e.g. "src/index.ts")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'writeFile',
    description: 'Create or overwrite a file in the workspace with the given content.',
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
    name: 'runCommand',
    description: 'Run a shell command in the workspace root directory. Returns stdout and stderr.',
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
