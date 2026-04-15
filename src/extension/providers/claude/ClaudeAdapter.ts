import * as vscode from 'vscode';

import type { AgentMessage, HandoffPacket, PersonaTemplate, ProviderHealth, ProposedFileEdit, ProposedTerminalCommand, Room, SquadAgent, TaskCard, TaskExecutionPlan, WorkspaceContext } from '../../../shared/model/index.js';
import type { ExecutionResult, OutgoingAgentMessage, PlanningResult, ProviderAdapter } from '../types.js';
import { createDeterministicAssignments, describePersonasForPrompt, enrichAssignments, tryFastRoute } from '../planningHints.js';
import { runToolCallLoop, buildPlanFromToolCalls } from '../../tools/toolCallLoop.js';

/**
 * Claude adapter — tries vscode.lm models with vendor/family containing "claude"
 * or "anthropic". Falls back to deterministic local routing when unavailable.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;
  private cachedModel: vscode.LanguageModelChat | undefined;
  private lastHealth: ProviderHealth = {
    provider: 'claude',
    state: 'ready',
    detail: 'Claude powers planning and task execution for this agent.',
  };

  getHealth(): ProviderHealth {
    return this.lastHealth;
  }

  async createPlan(
    prompt: string,
    personas: PersonaTemplate[],
    workspaceContext: WorkspaceContext,
    model?: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
  ): Promise<PlanningResult> {
    // Fast path: skip LLM for clearly single-domain tasks (zero network latency)
    const fastAssignments = tryFastRoute(prompt, personas);
    if (fastAssignments) {
      this.lastHealth = { provider: 'claude', state: 'ready', detail: 'Fast-routed via keyword match (no LLM call).' };
      return {
        title: prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt,
        summary: 'Pixel Squad fast-routed this task to the best-matched agent without a planning call.',
        assignments: fastAssignments,
        providerDetail: this.lastHealth.detail,
      };
    }

    const resolvedModel = model ?? (await this.pickModel());
    if (!resolvedModel) {
      this.lastHealth = {
        provider: 'claude',
        state: 'unavailable',
        detail: 'No Claude model was available in VS Code. Used local routing heuristics instead.',
      };
      return this.createFallbackPlan(prompt, personas, this.lastHealth.detail);
    }

    try {
      const response = await resolvedModel.sendRequest(
        [vscode.LanguageModelChatMessage.User(this.buildPrompt(prompt, personas, workspaceContext))],
        {},
        token,
      );

      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }

      const parsed = this.parsePlan(text, personas);
      this.lastHealth = {
        provider: 'claude',
        state: 'ready',
        detail: `Planned via ${resolvedModel.vendor}/${resolvedModel.family}.`,
      };

      return { ...parsed, providerDetail: this.lastHealth.detail };
    } catch (error) {
      const detail =
        error instanceof Error
          ? `Claude planning failed (${error.message}). Used local routing heuristics.`
          : 'Claude planning failed. Used local routing heuristics.';
      this.lastHealth = { provider: 'claude', state: 'unavailable', detail };
      return this.createFallbackPlan(prompt, personas, detail);
    }
  }

  async executeTask(
    task: TaskCard,
    agent: SquadAgent,
    persona: PersonaTemplate,
    workspaceContext: WorkspaceContext,
    model?: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
    room?: Room,
    handoffPackets?: HandoffPacket[],
    inboxMessages?: AgentMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<ExecutionResult> {
    const resolvedModel = model ?? (await this.pickModel());
    if (!resolvedModel) {
      const fallbackPlan = this.createFallbackExecutionPlan(task, workspaceContext);
      return {
        output: fallbackPlan.summary,
        success: true,
        plan: fallbackPlan,
      };
    }

    const rootPath = workspaceContext.workspaceRoot;
    if (!rootPath) {
      return this.executeTaskJsonFallback(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
    }

    try {
      const prompt = this.buildExecutionPrompt(task, agent, persona, workspaceContext, room, handoffPackets, inboxMessages);
      const { text, toolCalls } = await runToolCallLoop(resolvedModel, prompt, rootPath, token, onChunk);

      this.lastHealth = {
        provider: 'claude',
        state: 'ready',
        detail: `Executed via ${resolvedModel.vendor}/${resolvedModel.family} with ${toolCalls.length} tool call(s).`,
      };

      const outgoingMessages: OutgoingAgentMessage[] = toolCalls
        .filter((c) => c.name === 'sendAgentMessage')
        .map((c) => ({
          toAgentId: String(c.input.toAgentId ?? ''),
          content: String(c.input.content ?? ''),
        }))
        .filter((m) => m.toAgentId && m.content);

      const plan = buildPlanFromToolCalls(
        text.slice(0, 400) || 'Task execution completed.',
        toolCalls,
      );

      return {
        output: text || plan.summary,
        success: true,
        plan,
        outgoingMessages: outgoingMessages.length > 0 ? outgoingMessages : undefined,
        done: true,
        toolsExecuted: toolCalls.some((c) => c.name === 'writeFile' || c.name === 'runCommand'),
      };
    } catch {
      onChunk?.('\n⚠️ Tool-calling unavailable, falling back to plan mode...\n');
      try {
        return await this.executeTaskJsonFallback(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
      } catch (fallbackError) {
        const detail = fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
        return {
          output: `Execution failed: ${detail}. Agent ${agent.name} could not complete "${task.title}".`,
          success: false,
        };
      }
    }
  }

  /** Build the natural-language prompt for tool-calling execution. */
  private buildExecutionPrompt(
    task: TaskCard,
    agent: SquadAgent,
    persona: PersonaTemplate,
    workspaceContext: WorkspaceContext,
    room?: Room,
    handoffPackets?: HandoffPacket[],
    inboxMessages?: AgentMessage[],
  ): string {
    const lines = [
      `You are ${agent.name}, a ${persona.specialty} agent in a multi-agent software factory called Pixel Squad.`,
      `Your role: ${persona.title}.`,
      '',
      'You have access to workspace tools: readFile, writeFile, listFiles, searchText, runCommand, sendAgentMessage.',
      'Use these tools to explore the codebase, understand the existing code, make necessary changes, and verify your work.',
      'When you are finished, provide a concise summary of what you accomplished.',
    ];

    if (room) {
      lines.push(`\nRoom: ${room.name} (${room.theme}) — ${room.purpose}`);
    }

    if (handoffPackets && handoffPackets.length > 0) {
      lines.push('\n--- Handoff from predecessor tasks ---');
      for (const packet of handoffPackets) {
        lines.push(`[From ${packet.fromAgentName} (task ${packet.fromTaskId})]`);
        lines.push(`Summary: ${packet.summary}`);
        if (packet.filesChanged.length > 0) { lines.push(`Files changed: ${packet.filesChanged.join(', ')}`); }
        if (packet.commandsRun.length > 0) { lines.push(`Commands run: ${packet.commandsRun.join('; ')}`); }
        if (packet.openIssues.length > 0) { lines.push(`Open issues: ${packet.openIssues.join('; ')}`); }
        if (packet.output) { lines.push(`Output: ${packet.output.slice(0, 500)}`); }
      }
      lines.push('--- End handoff ---');
    }

    if (inboxMessages && inboxMessages.length > 0) {
      lines.push('\n--- Messages from other agents ---');
      for (const msg of inboxMessages) {
        lines.push(`[${msg.type.toUpperCase()} from agent ${msg.fromAgentId}]: ${msg.content}`);
      }
      lines.push('--- End messages ---');
    }

    lines.push(
      `\nTask: ${task.title}`,
      `Details: ${task.detail}`,
      `\nWorkspace branch: ${workspaceContext.branch || 'unknown'}`,
      `Active file: ${workspaceContext.activeFile || 'none'}`,
      `Git status: ${(workspaceContext.gitStatus ?? []).join(' | ') || 'clean or unavailable'}`,
    );

    if (workspaceContext.relevantFiles.length > 0) {
      lines.push('\nRelevant files (use readFile to inspect):');
      for (const f of workspaceContext.relevantFiles) {
        lines.push(`  ${f.path} — ${f.reason}`);
      }
    }

    lines.push('', 'Be direct and practical. Read files before modifying them.');
    return lines.join('\n');
  }

  /** Legacy JSON-parse execution path used as fallback when tool-calling is unavailable. */
  private async executeTaskJsonFallback(
    task: TaskCard,
    agent: SquadAgent,
    persona: PersonaTemplate,
    workspaceContext: WorkspaceContext,
    resolvedModel: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
    room?: Room,
    handoffPackets?: HandoffPacket[],
    inboxMessages?: AgentMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<ExecutionResult> {
    try {
      const promptLines = [
        `You are ${agent.name}, a ${persona.specialty} agent in a multi-agent software factory called Pixel Squad.`,
        `Your role: ${persona.title}.`,
        'Return valid JSON only with this exact shape:',
        '{"summary":"string","output":"string","fileEdits":[{"filePath":"relative/path","action":"create|replace","summary":"string","content":"full file content"}],"terminalCommands":[{"command":"string","summary":"string"}],"tests":["string"],"notes":["string"],"agentMessages":[{"toAgentId":"string","content":"string"}],"done":true}',
        'Use only workspace-relative paths for fileEdits.',
        'fileEdits should contain at most 3 items and only when you are confident.',
        'If you are changing an existing file, return the full replacement content.',
        'If no file change is appropriate, return an empty array.',
        'agentMessages: optional array of messages to send to other agents in your room. Use this to request help, share findings, or coordinate work. Set toAgentId to the target agent ID.',
        'done: set to true when your work is complete. Set to false if you need to wait for a reply from another agent.',
      ];

      // Room context
      if (room) {
        promptLines.push(`Room: ${room.name} (${room.theme}) — ${room.purpose}`);
      }

      // Handoff packets from predecessors
      if (handoffPackets && handoffPackets.length > 0) {
        promptLines.push('--- Handoff from predecessor tasks ---');
        for (const packet of handoffPackets) {
          promptLines.push(`[From ${packet.fromAgentName} (task ${packet.fromTaskId})]`);
          promptLines.push(`Summary: ${packet.summary}`);
          if (packet.filesChanged.length > 0) { promptLines.push(`Files changed: ${packet.filesChanged.join(', ')}`); }
          if (packet.commandsRun.length > 0) { promptLines.push(`Commands run: ${packet.commandsRun.join('; ')}`); }
          if (packet.openIssues.length > 0) { promptLines.push(`Open issues/notes: ${packet.openIssues.join('; ')}`); }
          if (packet.output) { promptLines.push(`Output: ${packet.output.slice(0, 500)}`); }
        }
        promptLines.push('--- End handoff ---');
      }

      // Inbox messages from other agents
      if (inboxMessages && inboxMessages.length > 0) {
        promptLines.push('--- Messages from other agents ---');
        for (const msg of inboxMessages) {
          promptLines.push(`[${msg.type.toUpperCase()} from agent ${msg.fromAgentId}]: ${msg.content}`);
        }
        promptLines.push('--- End messages ---');
      }

      promptLines.push(
        `Task: ${task.title}`,
        `Details: ${task.detail}`,
        `Workspace branch: ${workspaceContext.branch || 'unknown'}`,
        `Active file: ${workspaceContext.activeFile || 'none'}`,
        `Selected text: ${workspaceContext.selectedText || 'none'}`,
        `Git status: ${(workspaceContext.gitStatus ?? []).join(' | ') || 'clean or unavailable'}`,
        `Relevant files:\n${this.describeRelevantFiles(workspaceContext)}`,
        '',
        'Be direct and practical.',
      );

      const prompt = promptLines.join('\n');

      const response = await resolvedModel.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token,
      );

      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
        onChunk?.(fragment);
      }

      this.lastHealth = {
        provider: 'claude',
        state: 'ready',
        detail: `Executed via ${resolvedModel.vendor}/${resolvedModel.family}.`,
      };

      const parsed = this.parseExecutionPlan(text);
      return {
        output: parsed.output,
        success: true,
        plan: parsed.plan,
        outgoingMessages: parsed.outgoingMessages,
        done: parsed.done,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      return {
        output: `Execution failed: ${detail}. Agent ${agent.name} could not complete "${task.title}".`,
        success: false,
      };
    }
  }

  private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    if (this.cachedModel) { return this.cachedModel; }
    // Try anthropic vendor first, then look for any model with 'claude' in the family
    const anthropicModels = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
    if (anthropicModels.length > 0) {
      this.cachedModel = anthropicModels[0];
      return this.cachedModel;
    }

    const allModels = await vscode.lm.selectChatModels();
    this.cachedModel = allModels.find(
      (m) =>
        m.family.toLowerCase().includes('claude') ||
        m.vendor.toLowerCase().includes('anthropic') ||
        m.vendor.toLowerCase().includes('claude'),
    );
    return this.cachedModel;
  }

  private buildPrompt(prompt: string, personas: PersonaTemplate[], workspaceContext: WorkspaceContext): string {
    // Keep planning prompts lean — routing doesn't need full file content.
    const contextHints = [
      workspaceContext.branch ? `branch: ${workspaceContext.branch}` : '',
      workspaceContext.activeFile ? `active file: ${workspaceContext.activeFile}` : '',
    ].filter(Boolean).join(', ');

    return [
      'You are Pixel Squad, a routing planner for a multi-agent software factory.',
      'Return valid JSON only — no markdown fences, no commentary:',
      '{"title":"string","summary":"string","assignments":[{"personaId":"string","title":"string","detail":"string","dependsOnPersonaIds":["string"],"requiredSkillIds":["string"],"progressLabel":"string"}]}',
      `Personas: ${describePersonasForPrompt(personas)}.`,
      contextHints ? `Context: ${contextHints}.` : '',
      'Rules: Use 1 assignment for a single-domain task. Use 2-3 only when the work genuinely spans independent components. Tasks without stated ordering can run in parallel — only populate dependsOnPersonaIds when task B truly cannot start until task A is done.',
      `Task: ${prompt}`,
    ].filter(Boolean).join(' ');
  }

  private parsePlan(text: string, personas: PersonaTemplate[]): PlanningResult {
    const normalized = text.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const raw = JSON.parse(normalized) as {
      title?: string;
      summary?: string;
      assignments?: Array<{
        personaId?: string;
        title?: string;
        detail?: string;
        dependsOnPersonaIds?: string[];
        requiredSkillIds?: string[];
        progressLabel?: string;
      }>;
    };

    const personaIds = new Set(personas.map((p) => p.id));
    const assignments = enrichAssignments((raw.assignments ?? [])
      .filter((item) => item.personaId && item.title && item.detail && personaIds.has(item.personaId))
      .slice(0, 3)
      .map((item) => ({
        personaId: item.personaId!,
        title: item.title!,
        detail: item.detail!,
        dependsOnPersonaIds: item.dependsOnPersonaIds,
        requiredSkillIds: item.requiredSkillIds,
        progressLabel: item.progressLabel,
      })), personas, text);

    if (!raw.title || !raw.summary || assignments.length === 0) {
      throw new Error('Model response was missing required planning fields.');
    }

    return { title: raw.title, summary: raw.summary, assignments, providerDetail: '' };
  }

  private createFallbackPlan(prompt: string, personas: PersonaTemplate[], detail: string): PlanningResult {
    return {
      title: prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt,
      summary: 'Pixel Squad generated a deterministic routing plan because a live Claude model was unavailable or failed.',
      assignments: createDeterministicAssignments(prompt, personas),
      providerDetail: detail,
    };
  }

  private parseExecutionPlan(text: string): { output: string; plan: TaskExecutionPlan; outgoingMessages?: OutgoingAgentMessage[]; done: boolean } {
    const normalized = text.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    type RawPlan = {
      summary?: string;
      output?: string;
      fileEdits?: ProposedFileEdit[];
      terminalCommands?: ProposedTerminalCommand[];
      tests?: string[];
      notes?: string[];
      agentMessages?: Array<{ toAgentId?: string; content?: string; type?: string }>;
      done?: boolean;
    };
    let raw: RawPlan;
    try {
      raw = JSON.parse(normalized) as RawPlan;
    } catch {
      // Model returned prose instead of JSON (e.g. "I need to ...") — surface it gracefully
      return {
        output: normalized.slice(0, 400) || 'Model returned a non-JSON response.',
        plan: {
          summary: 'Model returned a non-JSON response. Review the output in notes.',
          fileEdits: [],
          terminalCommands: [],
          commandResults: [],
          tests: [],
          notes: [normalized.slice(0, 800) || 'No output captured.'],
        },
        done: true,
      };
    }

    const plan: TaskExecutionPlan = {
      summary: raw.summary?.trim() || 'Execution plan prepared for review.',
      fileEdits: (raw.fileEdits ?? []).filter((edit) => Boolean(edit?.filePath && edit?.action && typeof edit?.content === 'string')).slice(0, 3),
      terminalCommands: (raw.terminalCommands ?? []).filter((command) => Boolean(command?.command)).slice(0, 5),
      commandResults: [],
      tests: (raw.tests ?? []).filter(Boolean).slice(0, 5),
      notes: (raw.notes ?? []).filter(Boolean).slice(0, 8),
    };

    const outgoingMessages: OutgoingAgentMessage[] = (raw.agentMessages ?? [])
      .filter((m) => m.toAgentId && m.content)
      .map((m) => ({ toAgentId: m.toAgentId!, content: m.content!, type: (m.type as OutgoingAgentMessage['type']) }));

    return {
      output: raw.output?.trim() || plan.summary,
      plan,
      outgoingMessages: outgoingMessages.length > 0 ? outgoingMessages : undefined,
      done: raw.done !== false,
    };
  }

  private createFallbackExecutionPlan(task: TaskCard, workspaceContext: WorkspaceContext): TaskExecutionPlan {
    const notes = [
      `Reviewed task scope: ${task.detail}`,
      'Prepared a deterministic fallback plan because no live model was available.',
    ];

    if (workspaceContext.activeFile) {
      notes.push(`Start from ${workspaceContext.activeFile}.`);
    }

    return {
      summary: `[Local fallback] Reviewed "${task.title}" and prepared a safe execution outline for review.`,
      fileEdits: [],
      terminalCommands: [],
      commandResults: [],
      tests: ['Run the relevant project build or smoke test after applying edits.'],
      notes,
    };
  }

  private describeRelevantFiles(workspaceContext: WorkspaceContext): string {
    if (workspaceContext.relevantFiles.length === 0) {
      return 'No relevant workspace files were captured.';
    }

    return workspaceContext.relevantFiles.map((file) => [
      `File: ${file.path}`,
      `Reason: ${file.reason}`,
      'Content:',
      file.content,
    ].join('\n')).join('\n\n');
  }
}
