import * as vscode from 'vscode';

import type { AgentMessage, HandoffPacket, PersonaTemplate, ProviderHealth, ProposedFileEdit, ProposedTerminalCommand, Room, SquadAgent, TaskCard, TaskExecutionPlan, WorkspaceContext } from '../../../shared/model/index.js';
import type { ExecutionResult, OutgoingAgentMessage, PlanningResult, ProviderAdapter } from '../types.js';
import { createDeterministicAssignments, describePersonasForPrompt, enrichAssignments, tryFastRoute } from '../planningHints.js';
import { runToolCallLoop, buildPlanFromToolCalls } from '../../tools/toolCallLoop.js';
import { runCopilotSdkPrompt } from './CopilotSdkBridge.js';

export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot' as const;
  private cachedModels: vscode.LanguageModelChat[] | undefined;
  private preferredRuntime: 'vscode-lm' | 'sdk-hybrid' = 'vscode-lm';
  private preferredModelId = '';
  private lastHealth: ProviderHealth = {
    provider: 'copilot',
    state: 'ready',
    detail: 'GitHub Copilot powers all planning and task execution for Pixel Squad.'
  };

  setRuntime(runtime: 'vscode-lm' | 'sdk-hybrid'): void {
    this.preferredRuntime = runtime;
  }

  setPreferredModelId(modelId: string): void {
    this.preferredModelId = modelId.trim();
  }

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

    if (this.preferredRuntime === 'sdk-hybrid') {
      try {
        const sdkResponse = await runCopilotSdkPrompt({
          model: this.pickSdkModel(),
          prompt: this.buildPrompt(prompt, personas, workspaceContext),
          cwd: workspaceContext.workspaceRoot,
        });
        const parsed = this.parsePlan(sdkResponse.content, personas);
        this.lastHealth = {
          provider: 'copilot',
          state: 'ready',
          detail: `Planned via GitHub Copilot SDK (${sdkResponse.model}).`,
        };

        return {
          ...parsed,
          providerDetail: this.lastHealth.detail,
        };
      } catch (error) {
        const detail = error instanceof Error
          ? `Copilot SDK planning failed (${error.message}). Falling back to VS Code LM.`
          : 'Copilot SDK planning failed. Falling back to VS Code LM.';
        this.lastHealth = {
          provider: 'copilot',
          state: 'ready',
          detail,
        };
      }
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
    const candidates = [...deduped.values()].filter((candidate) => !excludedIds.includes(candidate.id));
    if (this.preferredModelId) {
      const preferred = candidates.find((candidate) => candidate.id === this.preferredModelId);
      if (preferred) {
        return preferred;
      }
    }
    return candidates[0];
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
      if (this.preferredRuntime === 'sdk-hybrid') {
        try {
          return await this.executePlanningTaskWithSdk(task, agent, persona, workspaceContext, room, handoffPackets, inboxMessages, onChunk);
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Unknown SDK error';
          onChunk?.('\n⚠️ Copilot SDK planning unavailable, falling back to VS Code LM...\n');
          this.lastHealth = {
            provider: 'copilot',
            state: 'ready',
            detail: `Copilot SDK planning unavailable (${detail}). Falling back to VS Code LM.`,
          };
        }
      }
      return this.executePlanningTask(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
    }

    const coordinationResult = this.executeCoordinationTask(task, agent, persona);
    if (coordinationResult) {
      return coordinationResult;
    }

    if (this.isSimpleExecutionTask(task, workspaceContext, handoffPackets, inboxMessages)) {
      this.lastHealth = {
        provider: 'copilot',
        state: 'ready',
        detail: 'Executed via compact JSON mode for a straightforward workspace edit.',
      };
      if (this.preferredRuntime === 'sdk-hybrid') {
        return this.executeTaskJsonFallbackWithSdk(task, agent, persona, workspaceContext, room, handoffPackets, inboxMessages, onChunk);
      }
      return this.executeTaskJsonFallback(task, agent, persona, workspaceContext, resolvedModel, token, room, handoffPackets, inboxMessages, onChunk);
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
        loopResult = await runToolCallLoop(resolvedModel, prompt, rootPath, token, onChunk, {
          preferExternalTools: task.toolPreference === 'mcp-first',
        });
      } catch (error) {
        if (!this.isQuotaExhaustedError(error)) {
          throw error;
        }
        const alternateModel = await this.pickModel(undefined, [resolvedModel.id]);
        if (!alternateModel) {
          throw error;
        }
        activeModel = alternateModel;
        loopResult = await runToolCallLoop(alternateModel, prompt, rootPath, token, onChunk, {
          preferExternalTools: task.toolPreference === 'mcp-first',
        });
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
      // Tool-calling failed (model doesn't support tools, etc.) — fall back to JSON plan mode
      onChunk?.('\n⚠️ Tool-calling unavailable, falling back to plan mode...\n');
      try {
        if (this.preferredRuntime === 'sdk-hybrid') {
          return await this.executeTaskJsonFallbackWithSdk(task, agent, persona, workspaceContext, room, handoffPackets, inboxMessages, onChunk);
        }
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

  private isSimpleExecutionTask(
    task: TaskCard,
    workspaceContext: WorkspaceContext,
    handoffPackets?: HandoffPacket[],
    inboxMessages?: AgentMessage[],
  ): boolean {
    if ((handoffPackets?.length ?? 0) > 0 || (inboxMessages?.length ?? 0) > 0) {
      return false;
    }
    if (task.toolPreference === 'mcp-first') {
      return false;
    }

    const text = `${task.title}\n${task.detail}`.toLowerCase();
    const editIntent = /\b(write|implement|fix|edit|modify|change|update|revise|append|populate|sync|save|replace|create)\b/.test(text);
    const commandHeavyIntent = /\b(run|execute|debug|install|build|test|verify|smoke|benchmark|profile)\b/.test(text);
    const planningOrRoutingIntent = /\b(plan|strategy|roadmap|proposal|architecture|route|delegate|handoff|split)\b/.test(text);
    const namedFileIntent = /\b[\w./-]+\.(md|markdown|txt|json|ya?ml|toml|tsx?|jsx?|css|scss|html|py|java|go|rs|cs|sql)\b/.test(text);
    const concreteWorkspaceTarget = namedFileIntent || Boolean(workspaceContext.activeFile) || workspaceContext.relevantFiles.length > 0;

    return editIntent && concreteWorkspaceTarget && !planningOrRoutingIntent && !commandHeavyIntent;
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

  private async executePlanningTaskWithSdk(
    task: TaskCard,
    agent: SquadAgent,
    persona: PersonaTemplate,
    workspaceContext: WorkspaceContext,
    room?: Room,
    handoffPackets?: HandoffPacket[],
    inboxMessages?: AgentMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<ExecutionResult> {
    const promptLines = [
      `You are ${agent.name}, a ${persona.specialty} agent in Pixel Squad.`,
      'This task is planning-only. Do not use tools, do not propose file edits, and do not run commands.',
      'Return a concise execution plan as plain text with these sections: Goal, Recommended implementation path, Step-by-step plan, Risks, Validation.',
      room ? `Room: ${room.name} (${room.theme}) — ${room.purpose}` : '',
      `Task: ${task.title}`,
      `Details: ${task.detail}`,
      `Workspace branch: ${workspaceContext.branch || 'unknown'}`,
      `Active file: ${workspaceContext.activeFile || 'none'}`,
      handoffPackets?.length ? `Prior handoff: ${handoffPackets.slice(0, 2).map((packet) => this.clipPromptText(packet.summary, 120)).join(' | ')}` : '',
      inboxMessages?.length ? `Agent messages: ${inboxMessages.slice(0, 3).map((message) => this.clipPromptText(message.content, 120)).join(' | ')}` : '',
    ].filter(Boolean);

    const response = await runCopilotSdkPrompt({
      model: this.pickSdkModel(),
      prompt: promptLines.join('\n'),
      stream: onChunk,
      cwd: workspaceContext.workspaceRoot,
    });
    const normalized = response.content.trim() || `Plan prepared for ${task.title}.`;
    this.lastHealth = {
      provider: 'copilot',
      state: 'ready',
      detail: `Planned via GitHub Copilot SDK (${response.model}).`,
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

  private async executeTaskJsonFallbackWithSdk(
    task: TaskCard,
    agent: SquadAgent,
    persona: PersonaTemplate,
    workspaceContext: WorkspaceContext,
    room?: Room,
    handoffPackets?: HandoffPacket[],
    inboxMessages?: AgentMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<ExecutionResult> {
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

    if (room) {
      promptLines.push(`Room: ${room.name} (${room.theme}) — ${room.purpose}`);
    }

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

    const response = await runCopilotSdkPrompt({
      model: this.pickSdkModel(),
      prompt: promptLines.join('\n'),
      stream: onChunk,
      cwd: workspaceContext.workspaceRoot,
    });

    this.lastHealth = {
      provider: 'copilot',
      state: 'ready',
      detail: `Executed via GitHub Copilot SDK (${response.model}).`,
    };

    const parsed = this.parseExecutionPlan(response.content);
    return {
      output: parsed.output,
      success: true,
      plan: parsed.plan,
      outgoingMessages: parsed.outgoingMessages,
      done: parsed.done,
    };
  }

  private pickSdkModel(): string {
    return 'gpt-5';
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
