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
  private cachedModels: vscode.LanguageModelChat[] | undefined;
  private preferredModelId = '';
  private lastHealth: ProviderHealth = {
    provider: 'claude',
    state: 'ready',
    detail: 'Claude powers planning and task execution for this agent.',
  };

  getHealth(): ProviderHealth {
    return this.lastHealth;
  }

  setPreferredModelId(modelId: string): void {
    this.preferredModelId = modelId.trim();
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

    if (this.isPlanningOnlyTask(task)) {
      return this.executePlanningTask(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
    }

    const coordinationResult = this.executeCoordinationTask(task, agent, persona);
    if (coordinationResult) {
      return coordinationResult;
    }

    const rootPath = workspaceContext.workspaceRoot;
    if (!rootPath) {
      return this.executeTaskJsonFallback(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
    }

    try {
      const prompt = this.buildExecutionPrompt(task, agent, persona, workspaceContext, room, handoffPackets, inboxMessages);
      const { text, toolCalls } = await runToolCallLoop(resolvedModel, prompt, rootPath, token, onChunk, {
        preferExternalTools: task.toolPreference === 'mcp-first',
      });

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

      const outgoingTaskRoutes = toolCalls
        .filter((c) => c.name === 'routeTask')
        .map((c) => ({
          personaId: String(c.input.personaId ?? ''),
          title: String(c.input.title ?? ''),
          detail: String(c.input.detail ?? ''),
        }))
        .filter((route) => route.personaId && route.title && route.detail);

      const plan = buildPlanFromToolCalls(
        text.slice(0, 400) || 'Task execution completed.',
        toolCalls,
      );

      return {
        output: text || plan.summary,
        success: true,
        plan,
        outgoingMessages: outgoingMessages.length > 0 ? outgoingMessages : undefined,
        outgoingTaskRoutes: outgoingTaskRoutes.length > 0 ? outgoingTaskRoutes : undefined,
        done: true,
        toolsExecuted: toolCalls.some((c) => c.name === 'writeFile' || c.name === 'editFile' || c.name === 'runCommand'),
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

  private isPlanningOnlyTask(task: TaskCard): boolean {
    const text = `${task.title}\n${task.detail}`.toLowerCase();
    const planningIntent = /\b(plan|strategy|roadmap|proposal|architecture|approach|business plan|deployment plan|migration plan|design doc|outline)\b/.test(text);
    const implementationIntent = /\b(write|implement|fix|edit|modify|change|update|revise|append|populate|sync|save|replace|run|execute|test|refactor|build|code|ship|patch|debug|install)\b/.test(text);
    const artifactIntent = /\b(create|generate|draft|author|produce|save|update|updated|revise|append|fill|populate|sync|edit|modify|write)\b[\s\S]{0,120}\b(brd|doc|docs|document|documentation|spec|specification|readme|markdown|md|file|files)\b/.test(text)
      || /\b(brd|doc|docs|document|documentation|spec|specification|readme|markdown|md|file|files)\b[\s\S]{0,120}\b(create|generate|draft|author|produce|save|update|updated|revise|append|fill|populate|sync|edit|modify|write)\b/.test(text)
      || (/\b[\w./-]+\.(md|markdown|txt|json|ya?ml|toml|tsx?|jsx?|css|scss|html|py|java|go|rs|cs|sql)\b/.test(text)
        && /\b(update|updated|edit|modify|change|revise|append|fill|populate|sync|save|write|create|generate)\b/.test(text));
    return planningIntent && !implementationIntent && !artifactIntent;
  }

  private isCoordinationOnlyTask(task: TaskCard): boolean {
    const text = `${task.title}\n${task.detail}`.toLowerCase();
    const coordinationIntent = /\b(assign|assignment|route|delegate|handoff|hand off|split|send to|post this assign)\b/.test(text);
    const implementationIntent = /\b(write|implement|fix|edit|modify|change|update|revise|append|populate|sync|save|replace|run|execute|test|refactor|build|code|ship|patch|debug|install)\b/.test(text);
    const artifactIntent = /\b(brd|doc|docs|document|documentation|spec|specification|readme|markdown|md|file|files)\b/.test(text);
    return coordinationIntent && !implementationIntent && !artifactIntent;
  }

  private executeCoordinationTask(task: TaskCard, agent: SquadAgent, persona: PersonaTemplate): ExecutionResult | undefined {
    if (!this.isCoordinationOnlyTask(task)) {
      return undefined;
    }

    const detail = `${task.title}\n${task.detail}`.toLowerCase();
    const baseRequest = this.summarizeCoordinationRequest(task.detail || task.title);
    const routes: Array<{ personaId: string; title: string; detail: string }> = [];
    const pushRoute = (personaId: string, title: string, routeDetail: string) => {
      if (personaId === persona.id || routes.some((route) => route.personaId === personaId)) {
        return;
      }
      routes.push({ personaId, title, detail: routeDetail });
    };

    if (/\b(frontend|front end|ui|webview)\b/.test(detail)) {
      pushRoute('frontend', 'Frontend handoff', `${baseRequest}\nFocus on frontend UI, webview, and interaction work.`);
    }
    if (/\b(backend|back end|api|server|data)\b/.test(detail)) {
      pushRoute('backend', 'Backend handoff', `${baseRequest}\nFocus on backend logic, API, runtime, and data work.`);
    }
    if (/\b(tester|testing|qa|verify|validation|regression|test)\b/.test(detail)) {
      pushRoute('tester', 'Testing handoff', `${baseRequest}\nFocus on validation, smoke testing, and regression coverage.`);
    }
    if (/\b(devops|deploy|pipeline|ci|release|infra)\b/.test(detail)) {
      pushRoute('devops', 'DevOps handoff', `${baseRequest}\nFocus on CI, deployment, release, or infrastructure follow-up.`);
    }
    if (/\b(design|ux|copy|journey|visual)\b/.test(detail)) {
      pushRoute('designer', 'Design handoff', `${baseRequest}\nFocus on UX, visual design, and product copy follow-up.`);
    }

    if (routes.length === 0) {
      return undefined;
    }

    return {
      output: `Routed ${routes.length} downstream task(s): ${routes.map((route) => route.personaId).join(', ')}.`,
      success: true,
      plan: {
        summary: `Coordination response for "${task.title}"`,
        fileEdits: [],
        terminalCommands: [],
        commandResults: [],
        tests: [],
        notes: [`Deterministically routed downstream work from ${agent.name}.`],
      },
      outgoingTaskRoutes: routes,
      done: true,
    };
  }

  private summarizeCoordinationRequest(detail: string): string {
    const firstUsefulLine = detail
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^(Current lane focus|Focus detail|Latest lane output|Relevant changed files|Predecessor handoff|Recent lane transcript|Treat this as a continuation)/.test(line));
    const normalized = firstUsefulLine ?? detail.trim();
    return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
  }

  private clipPromptText(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
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
      handoffPackets?.length ? `Prior handoff: ${handoffPackets.slice(0, 2).map((packet) => this.clipPromptText(packet.summary, 120)).join(' | ')}` : '',
      inboxMessages?.length ? `Agent messages: ${inboxMessages.slice(0, 3).map((message) => this.clipPromptText(message.content, 120)).join(' | ')}` : '',
    ].filter(Boolean);

    try {
      const response = await resolvedModel.sendRequest(
        [vscode.LanguageModelChatMessage.User(promptLines.join('\n'))],
        {},
        token,
      );

      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
        onChunk?.(fragment);
      }

      const normalized = text.trim() || `Plan prepared for ${task.title}.`;
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
      'You have access to workspace tools: readFile, editFile, writeFile, listFiles, searchText, getDiagnostics, runCommand, sendAgentMessage, routeTask.',
      'Use routeTask whenever your completed work should automatically hand off to another owning persona in the current run.',
      'If the task requires external data, cloud resources, hosted search, repo metadata, API access, or other non-workspace context, prefer any MCP or extension-provided tool surfaced by VS Code before relying only on local workspace tools.',
      'Use editFile for targeted changes to existing files (preferred over writeFile for modifications).',
      'If the task names a file path or asks to update an existing doc/spec/plan, modify that file directly instead of replying with only a prose plan.',
      'Treat the active file and pinned files as likely edit targets when they match the request, even if the prompt does not explicitly say "create file".',
      'After making edits, use getDiagnostics to check for compile/lint errors and fix any issues before finishing.',
      'When you are finished, provide a concise summary of what you accomplished.',
    ];

    if (room) {
      lines.push(`\nRoom: ${room.name} (${room.theme}) — ${room.purpose}`);
    }

    if (handoffPackets && handoffPackets.length > 0) {
      lines.push('\n--- Handoff from predecessor tasks ---');
      for (const packet of handoffPackets.slice(0, 2)) {
        lines.push(`[From ${packet.fromAgentName} (task ${packet.fromTaskId})]`);
        lines.push(`Summary: ${this.clipPromptText(packet.summary, 160)}`);
        if (packet.filesChanged.length > 0) { lines.push(`Files changed: ${packet.filesChanged.slice(0, 4).join(', ')}`); }
        if (packet.commandsRun.length > 0) { lines.push(`Commands run: ${packet.commandsRun.slice(0, 3).map((entry) => this.clipPromptText(entry, 60)).join('; ')}`); }
        if (packet.openIssues.length > 0) { lines.push(`Open issues: ${packet.openIssues.slice(0, 3).map((entry) => this.clipPromptText(entry, 80)).join('; ')}`); }
        if (packet.output) { lines.push(`Output: ${this.clipPromptText(packet.output, 180)}`); }
      }
      lines.push('--- End handoff ---');
    }

    if (inboxMessages && inboxMessages.length > 0) {
      lines.push('\n--- Messages from other agents ---');
      for (const msg of inboxMessages.slice(0, 3)) {
        lines.push(`[${msg.type.toUpperCase()} from agent ${msg.fromAgentId}]: ${this.clipPromptText(msg.content, 140)}`);
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
        'If the task mentions a named file or asks to update an existing plan/doc/spec, include that file in fileEdits instead of returning only notes.',
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
        for (const packet of handoffPackets.slice(0, 2)) {
          promptLines.push(`[From ${packet.fromAgentName} (task ${packet.fromTaskId})]`);
          promptLines.push(`Summary: ${this.clipPromptText(packet.summary, 160)}`);
          if (packet.filesChanged.length > 0) { promptLines.push(`Files changed: ${packet.filesChanged.slice(0, 4).join(', ')}`); }
          if (packet.commandsRun.length > 0) { promptLines.push(`Commands run: ${packet.commandsRun.slice(0, 3).map((entry) => this.clipPromptText(entry, 60)).join('; ')}`); }
          if (packet.openIssues.length > 0) { promptLines.push(`Open issues/notes: ${packet.openIssues.slice(0, 3).map((entry) => this.clipPromptText(entry, 80)).join('; ')}`); }
          if (packet.output) { promptLines.push(`Output: ${this.clipPromptText(packet.output, 180)}`); }
        }
        promptLines.push('--- End handoff ---');
      }

      // Inbox messages from other agents
      if (inboxMessages && inboxMessages.length > 0) {
        promptLines.push('--- Messages from other agents ---');
        for (const msg of inboxMessages.slice(0, 3)) {
          promptLines.push(`[${msg.type.toUpperCase()} from agent ${msg.fromAgentId}]: ${this.clipPromptText(msg.content, 140)}`);
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
    if (!this.cachedModels) {
      const anthropicModels = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
      const allModels = await vscode.lm.selectChatModels();
      const combined = [...anthropicModels, ...allModels.filter(
        (m) =>
          m.family.toLowerCase().includes('claude') ||
          m.vendor.toLowerCase().includes('anthropic') ||
          m.vendor.toLowerCase().includes('claude'),
      )];
      const deduped = new Map<string, vscode.LanguageModelChat>();
      for (const model of combined) {
        deduped.set(model.id, model);
      }
      this.cachedModels = [...deduped.values()];
    }

    if (this.preferredModelId) {
      const preferred = this.cachedModels.find((model) => model.id === this.preferredModelId);
      if (preferred) {
        return preferred;
      }
    }

    return this.cachedModels[0];
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
