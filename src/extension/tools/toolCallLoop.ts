import * as vscode from 'vscode';
import { handleToolCall, type ToolCallRecord } from './handlers.js';
import { WORKSPACE_TOOLS } from './definitions.js';
import type { ProposedFileEdit, ProposedTerminalCommand, TaskExecutionPlan, CommandExecutionResult } from '../../shared/model/index.js';

/** Maximum rounds of tool-calling before we force-stop. */
const MAX_TOOL_ROUNDS = 8;

/* ── MCP / external tool discovery ──────────────────────── */

/** Discover tools registered by MCP servers or other extensions. */
export function discoverExternalTools(): vscode.LanguageModelChatTool[] {
  try {
    const lm = vscode.lm as typeof vscode.lm & { tools?: readonly { name: string; description: string; inputSchema?: object }[] };
    if (lm.tools && Array.isArray(lm.tools)) {
      const ownNames = new Set(WORKSPACE_TOOLS.map((t) => t.name));
      return lm.tools
        .filter((t) => !ownNames.has(t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    }
  } catch { /* API not available in this VS Code version */ }
  return [];
}

/** Try to invoke an externally-registered tool (MCP / extension-provided). */
async function invokeExternalTool(
  name: string,
  input: Record<string, unknown>,
  token?: vscode.CancellationToken,
): Promise<{ content: string; isError: boolean }> {
  try {
    const lm = vscode.lm as typeof vscode.lm & { invokeTool?: (name: string, options: object, token?: vscode.CancellationToken) => Promise<unknown> };
    if (typeof lm.invokeTool === 'function') {
      const result = await lm.invokeTool(name, { input }, token);
      if (result && typeof (result as Iterable<unknown>)[Symbol.iterator] === 'function') {
        const texts: string[] = [];
        for (const part of result as Iterable<{ value?: string }>) {
          if (part instanceof vscode.LanguageModelTextPart) { texts.push(part.value); }
          else if (typeof part.value === 'string') { texts.push(part.value); }
        }
        return { content: texts.join(''), isError: false };
      }
      return { content: String(result), isError: false };
    }
  } catch (err) {
    return {
      content: `External tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
  return { content: `Tool "${name}" not available.`, isError: true };
}

/* ── Tool-calling loop ──────────────────────────────────── */

export interface ToolCallLoopResult {
  text: string;
  toolCalls: ToolCallRecord[];
}

export interface ToolCallLoopOptions {
  preferExternalTools?: boolean;
}

/**
 * Run the agentic tool-calling loop:
 * send prompt → stream response → handle tool calls → feed results back → repeat.
 *
 * The loop ends when the model returns a text-only response (no tool calls)
 * or when MAX_TOOL_ROUNDS is reached.
 */
export async function runToolCallLoop(
  model: vscode.LanguageModelChat,
  prompt: string,
  rootPath: string,
  token?: vscode.CancellationToken,
  onChunk?: (chunk: string) => void,
  options?: ToolCallLoopOptions,
): Promise<ToolCallLoopResult> {
  const externalTools = discoverExternalTools();
  const prefersExternalTools = options?.preferExternalTools ?? taskLikelyNeedsExternalAccess(prompt);
  const allTools = prefersExternalTools
    ? [...externalTools, ...WORKSPACE_TOOLS]
    : [...WORKSPACE_TOOLS, ...externalTools];
  const ownToolNames = new Set(WORKSPACE_TOOLS.map((t) => t.name));
  const externalToolNames = externalTools.map((tool) => tool.name);

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      'SYSTEM: You are an agentic coding assistant. Follow this workflow:\n'
      + '1. Read files before modifying them.\n'
      + '2. Use editFile for targeted changes to existing files (prefer over writeFile).\n'
      + '3. After making edits or running commands, use getDiagnostics to check for errors.\n'
      + '4. If diagnostics reveal errors, fix them before moving on.\n'
      + `5. If task requires external system access, hosted knowledge, repo metadata, cloud operations, API calls, or data not present in workspace, first use a surfaced MCP/extension tool when one matches need${externalToolNames.length > 0 ? `: ${externalToolNames.join(', ')}` : ''}. Only fall back to workspace tools or prose when no suitable external tool exists.\n`
      + '6. When finished, provide a concise summary of what was accomplished.',
    ),
    vscode.LanguageModelChatMessage.User(prompt),
  ];
  const allToolCallRecords: ToolCallRecord[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await model.sendRequest(messages, { tools: allTools }, token);

    const textChunks: string[] = [];
    const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
    const responseParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textChunks.push(part.value);
        onChunk?.(part.value);
        responseParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        onChunk?.(`\n🔧 ${part.name}(${summarizeInput(part.input)})\n`);
        toolCallParts.push(part);
        responseParts.push(part);
      }
    }

    // Record the assistant's response (text + tool calls)
    messages.push(vscode.LanguageModelChatMessage.Assistant(responseParts));

    // If no tool calls, we've reached the final answer
    if (toolCallParts.length === 0) {
      return { text: textChunks.join(''), toolCalls: allToolCallRecords };
    }

    // Execute each tool call and feed results back to the model
    const toolResults: vscode.LanguageModelToolResultPart[] = [];
    let autoFixHint = '';
    for (const call of toolCallParts) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      let result: { content: string; isError: boolean };

      if (ownToolNames.has(call.name)) {
        const localResult = await handleToolCall(call.name, input, rootPath);
        result = { content: localResult.content, isError: localResult.isError ?? false };
      } else {
        result = await invokeExternalTool(call.name, input, token);
      }

      allToolCallRecords.push({
        name: call.name,
        input,
        output: result.content.slice(0, 2000),
        isError: result.isError,
      });

      // Auto-fix hint: if a command fails, prompt the agent to analyse and fix
      if (call.name === 'runCommand' && result.isError) {
        const cmd = String(input.command ?? '');
        autoFixHint = `The command "${cmd}" failed with the above error. `
          + 'Read the relevant source files, apply a targeted fix using editFile, then re-run the command. '
          + 'Run getDiagnostics afterwards to confirm there are no remaining errors.';
        onChunk?.(`\n⚠️ Command failed — triggering auto-fix cycle…\n`);
      }

      // Stream the tool result summary so the user sees progress
      const resultPreview = result.content.slice(0, 120).replace(/\n/g, ' ');
      onChunk?.(`  → ${result.isError ? '❌' : '✓'} ${resultPreview}\n`);

      toolResults.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(result.content),
        ]),
      );
    }

    messages.push(vscode.LanguageModelChatMessage.User(toolResults));

    // Append auto-fix instruction as a follow-up user message so the model sees it next round
    if (autoFixHint) {
      messages.push(vscode.LanguageModelChatMessage.User(autoFixHint));
    }
  }

  // Exhausted all rounds
  return {
    text: 'Agent reached the maximum number of tool-calling rounds.',
    toolCalls: allToolCallRecords,
  };
}

/* ── Plan builder ───────────────────────────────────────── */

/**
 * Build a TaskExecutionPlan from tool call records.
 * This converts the recorded tool invocations into the structured plan
 * format the UI understands (file edits, terminal commands, notes).
 */
export function buildPlanFromToolCalls(
  summary: string,
  toolCalls: ToolCallRecord[],
): TaskExecutionPlan {
  const fileEdits: ProposedFileEdit[] = [];
  const terminalCommands: ProposedTerminalCommand[] = [];
  const commandResults: CommandExecutionResult[] = [];
  const notes: string[] = [];

  for (const call of toolCalls) {
    switch (call.name) {
      case 'writeFile':
        fileEdits.push({
          filePath: String(call.input.path ?? ''),
          action: 'create',
          summary: call.output,
          content: String(call.input.content ?? ''),
        });
        break;

      case 'editFile':
        fileEdits.push({
          filePath: String(call.input.path ?? ''),
          action: 'replace',
          summary: call.output,
          content: String(call.input.newString ?? ''),
        });
        break;

      case 'runCommand': {
        const idx = terminalCommands.length;
        const cmd = String(call.input.command ?? '');
        terminalCommands.push({ command: cmd, summary: call.output.slice(0, 200) });
        commandResults.push({
          commandIndex: idx,
          command: cmd,
          summary: call.output.slice(0, 200),
          status: call.isError ? 'failed' : 'succeeded',
          stdout: call.isError ? undefined : call.output,
          stderr: call.isError ? call.output : undefined,
        });
        break;
      }

      case 'readFile':
      case 'listFiles':
      case 'searchText':
      case 'getDiagnostics':
        notes.push(`[${call.name}] ${JSON.stringify(call.input).slice(0, 120)}`);
        break;

      case 'sendAgentMessage':
      case 'routeTask':
        // Handled separately by the adapter for outgoing messages
        break;

      default:
        // MCP / external tools
        notes.push(`[${call.name}] ${call.output.slice(0, 200)}`);
        break;
    }
  }

  return {
    summary,
    fileEdits,
    terminalCommands,
    commandResults,
    tests: [],
    notes,
  };
}

/* ── Helpers ────────────────────────────────────────────── */

function summarizeInput(input: object): string {
  const raw = JSON.stringify(input);
  return raw.length > 60 ? raw.slice(0, 57) + '...' : raw;
}

export function taskLikelyNeedsExternalAccess(prompt: string): boolean {
  return /\b(mcp|external|github|gitlab|repo metadata|pull request|issue|cloud|azure|aws|gcp|search|knowledge|documentation|docs|api|service|deployment|resource|subscription|tenant|database|postgres|mysql|sql|redis|cosmos|storage|kubernetes|aks)\b/i.test(prompt);
}
