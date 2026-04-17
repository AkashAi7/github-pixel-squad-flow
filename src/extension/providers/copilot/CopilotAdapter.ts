import * as vscode from 'vscode';

import type { AgentMessage, HandoffPacket, PersonaTemplate, ProviderHealth, ProposedFileEdit, ProposedTerminalCommand, Room, SquadAgent, TaskCard, TaskExecutionPlan, WorkspaceContext } from '../../../shared/model/index.js';
import type { ExecutionResult, OutgoingAgentMessage, PlanningResult, ProviderAdapter } from '../types.js';
import { createDeterministicAssignments, describePersonasForPrompt, enrichAssignments, tryFastRoute } from '../planningHints.js';
import { runToolCallLoop, buildPlanFromToolCalls } from '../../tools/toolCallLoop.js';

export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot' as const;
  private cachedModels: vscode.LanguageModelChat[] | undefined;
  private lastHealth: ProviderHealth = {
    provider: 'copilot',
    state: 'ready',
    detail: 'GitHub Copilot powers all planning and task execution for Pixel Squad.'
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
      this.lastHealth = { provider: 'copilot', state: 'ready', detail: 'Fast-routed via keyword match (no LLM call).' };
      return {
        title: prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt,
        summary: 'Pixel Squad fast-routed this task to the best-matched agent without a planning call.',
        assignments: fastAssignments,
        providerDetail: this.lastHealth.detail,
      };
    }

    const resolvedModel = await this.pickModel(model);
    if (!resolvedModel) {
      this.lastHealth = {
        provider: 'copilot',
        state: 'unavailable',
        detail: 'No GitHub Copilot chat model was available. Pixel Squad used local routing heuristics instead.'
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
        provider: 'copilot',
        state: 'ready',
        detail: `Planned via ${resolvedModel.vendor}/${resolvedModel.family}.`
      };

      return {
        ...parsed,
        providerDetail: this.lastHealth.detail
      };
    } catch (error) {
      const detail = this.isQuotaExhaustedError(error)
        ? 'Copilot premium quota was exhausted. Pixel Squad switched to lightweight local routing for this step.'
        : error instanceof Error
          ? `Copilot planning failed (${error.message}). Pixel Squad used local routing heuristics instead.`
          : 'Copilot planning failed. Pixel Squad used local routing heuristics instead.';
      this.lastHealth = {
        provider: 'copilot',
        state: 'unavailable',
        detail
      };
      return this.createFallbackPlan(prompt, personas, detail);
    }
  }

  private async pickModel(preferredModel?: vscode.LanguageModelChat, excludedIds: string[] = []): Promise<vscode.LanguageModelChat | undefined> {
    if (!this.cachedModels) {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      this.cachedModels = [...models].sort((left, right) => this.scoreModel(right) - this.scoreModel(left));
    }

    const deduped = new Map<string, vscode.LanguageModelChat>();
    if (preferredModel) {
      deduped.set(preferredModel.id, preferredModel);
    }
    for (const model of this.cachedModels) {
      deduped.set(model.id, model);
    }
    return [...deduped.values()].find((candidate) => !excludedIds.includes(candidate.id));
  }

  private scoreModel(model: vscode.LanguageModelChat): number {
    const haystack = `${model.id} ${model.name} ${model.family} ${model.version}`.toLowerCase();
    let score = 0;
    if (haystack.includes('auto')) score += 1000;
    if (haystack.includes('mini')) score += 400;
    if (haystack.includes('flash')) score += 200;
    if (haystack.includes('4o-mini') || haystack.includes('4.1-mini')) score += 250;
    if (haystack.includes('gpt-5') || haystack.includes('o1') || haystack.includes('o3') || haystack.includes('o4') || haystack.includes('sonnet') || haystack.includes('opus')) score -= 150;
    return score;
  }

  private isQuotaExhaustedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('premium model quota') || message.includes('premium requests') || message.includes('allowance to renew') || message.includes('quota');
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
    const resolvedModel = await this.pickModel(model);
    if (!resolvedModel) {
      const fallbackPlan = this.createFallbackExecutionPlan(task, workspaceContext);
      return {
        output: fallbackPlan.summary,
        success: true,
        plan: fallbackPlan,
      };
    }

    if (this.isPlanningOnlyTask(task)) {
      return this.executePlanningTask(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
    }

    const rootPath = workspaceContext.workspaceRoot;
    if (!rootPath) {
      // No workspace root — fall back to JSON plan mode
      return this.executeTaskJsonFallback(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
    }

    try {
      const prompt = this.buildExecutionPrompt(task, agent, persona, workspaceContext, room, handoffPackets, inboxMessages);
      let activeModel = resolvedModel;
      let loopResult;
      try {
        loopResult = await runToolCallLoop(resolvedModel, prompt, rootPath, token, onChunk);
      } catch (error) {
        if (!this.isQuotaExhaustedError(error)) {
          throw error;
        }
        const alternateModel = await this.pickModel(undefined, [resolvedModel.id]);
        if (!alternateModel) {
          throw error;
        }
        activeModel = alternateModel;
        loopResult = await runToolCallLoop(alternateModel, prompt, rootPath, token, onChunk);
      }
      const { text, toolCalls } = loopResult;

      this.lastHealth = {
        provider: 'copilot',
        state: 'ready',
        detail: `Executed via ${activeModel.vendor}/${activeModel.family} with ${toolCalls.length} tool call(s).`,
      };

      // Extract agent messages from sendAgentMessage tool calls
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
        toolsExecuted: toolCalls.some((c) => c.name === 'writeFile' || c.name === 'editFile' || c.name === 'runCommand'),
      };
    } catch {
      // Tool-calling failed (model doesn't support tools, etc.) — fall back to JSON plan mode
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

  private isPlanningOnlyTask(task: TaskCard): boolean {
    const text = `${task.title}\n${task.detail}`.toLowerCase();
    const planningIntent = /\b(plan|strategy|roadmap|proposal|architecture|approach|business plan|deployment plan|migration plan|design doc|outline)\b/.test(text);
    const implementationIntent = /\b(write|implement|fix|edit|modify|change|run|execute|test|refactor|build|code|ship|patch|debug|install)\b/.test(text);
    const artifactIntent = /\b(create|generate|draft|author|produce|save)\b[\s\S]{0,80}\b(brd|doc|docs|document|documentation|spec|specification|readme|markdown|md|file|files)\b/.test(text)
      || /\b(brd|doc|docs|document|documentation|spec|specification|readme|markdown|md|file|files)\b[\s\S]{0,80}\b(create|generate|draft|author|produce|save)\b/.test(text);
    return planningIntent && !implementationIntent && !artifactIntent;
  }

  private async executePlanningTask(
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
    const promptLines = [
      `You are ${agent.name}, a ${persona.specialty} agent in Pixel Squad.`,
      'This task is planning-only. Do not use tools, do not propose file edits, and do not run commands.',
      'Return a concise execution plan as plain text with these sections: Goal, Recommended Azure/implementation path, Step-by-step plan, Risks, Validation.',
      room ? `Room: ${room.name} (${room.theme}) — ${room.purpose}` : '',
      `Task: ${task.title}`,
      `Details: ${task.detail}`,
      `Workspace branch: ${workspaceContext.branch || 'unknown'}`,
      `Active file: ${workspaceContext.activeFile || 'none'}`,
      handoffPackets?.length ? `Prior handoff: ${handoffPackets.map((packet) => packet.summary).join(' | ')}` : '',
      inboxMessages?.length ? `Agent messages: ${inboxMessages.map((message) => message.content).join(' | ')}` : '',
    ].filter(Boolean);

    try {
      let activeModel = resolvedModel;
      let text = '';
      const runRequest = async (candidate: vscode.LanguageModelChat) => {
        const response = await candidate.sendRequest(
          [vscode.LanguageModelChatMessage.User(promptLines.join('\n'))],
          {},
          token,
        );
        let buffer = '';
        for await (const fragment of response.text) {
          buffer += fragment;
          onChunk?.(fragment);
        }
        return buffer;
      };
      try {
        text = await runRequest(resolvedModel);
      } catch (error) {
        if (!this.isQuotaExhaustedError(error)) {
          throw error;
        }
        const alternateModel = await this.pickModel(undefined, [resolvedModel.id]);
        if (!alternateModel) {
          throw error;
        }
        activeModel = alternateModel;
        text = await runRequest(alternateModel);
      }

      const normalized = text.trim() || `Plan prepared for ${task.title}.`;
      this.lastHealth = {
        provider: 'copilot',
        state: 'ready',
        detail: `Planned via ${activeModel.vendor}/${activeModel.family}.`,
      };
      return {
        output: normalized,
        success: true,
        plan: {
          summary: `Planning response for "${task.title}"`,
          fileEdits: [],
          terminalCommands: [],
          commandResults: [],
          tests: [],
          notes: [normalized.slice(0, 2000)],
        },
        done: true,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown planning error';
      return {
        output: `Planning failed: ${detail}`,
        success: false,
      };
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
      'You have access to workspace tools: readFile, editFile, writeFile, listFiles, searchText, getDiagnostics, runCommand, sendAgentMessage.',
      'You also have access to any MCP or extension-provided tools surfaced by VS Code for this session. Use them when they are the best tool for the job.',
      'Use editFile for targeted changes to existing files (preferred over writeFile for modifications).',
      'After making edits, use getDiagnostics to check for compile/lint errors and fix any issues before finishing.',
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

    // Include file hints (names + reasons only — agent uses readFile for content)
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

      let activeModel = resolvedModel;
      let text = '';
      const runRequest = async (candidate: vscode.LanguageModelChat) => {
        const response = await candidate.sendRequest(
          [vscode.LanguageModelChatMessage.User(prompt)],
          {},
          token,
        );
        let buffer = '';
        for await (const fragment of response.text) {
          buffer += fragment;
          onChunk?.(fragment);
        }
        return buffer;
      };
      try {
        text = await runRequest(resolvedModel);
      } catch (error) {
        if (!this.isQuotaExhaustedError(error)) {
          throw error;
        }
        const alternateModel = await this.pickModel(undefined, [resolvedModel.id]);
        if (!alternateModel) {
          throw error;
        }
        activeModel = alternateModel;
        text = await runRequest(alternateModel);
      }

      this.lastHealth = {
        provider: 'copilot',
        state: 'ready',
        detail: `Executed via ${activeModel.vendor}/${activeModel.family}.`
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

  private buildPrompt(prompt: string, personas: PersonaTemplate[], workspaceContext: WorkspaceContext): string {
    // Keep the planning prompt lean — routing decisions don't need full file content.
    // Workspace context is used for execution, not routing.
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

    const personaIds = new Set(personas.map((persona) => persona.id));
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

    return {
      title: raw.title,
      summary: raw.summary,
      assignments,
      providerDetail: ''
    };
  }

  private createFallbackPlan(prompt: string, personas: PersonaTemplate[], detail: string): PlanningResult {
    return {
      title: prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt,
      summary: 'Pixel Squad generated a deterministic routing plan because a live GitHub Copilot model was unavailable or failed.',
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
