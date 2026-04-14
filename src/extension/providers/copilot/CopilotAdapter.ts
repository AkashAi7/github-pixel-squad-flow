import * as vscode from 'vscode';

import type { AgentMessage, HandoffPacket, PersonaTemplate, ProviderHealth, ProposedFileEdit, ProposedTerminalCommand, Room, SquadAgent, TaskCard, TaskExecutionPlan, WorkspaceContext } from '../../../shared/model/index.js';
import type { ExecutionResult, OutgoingAgentMessage, PlanningResult, ProviderAdapter } from '../types.js';
import { createDeterministicAssignments, describePersonasForPrompt, enrichAssignments } from '../planningHints.js';

export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot' as const;
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
    const resolvedModel = model ?? (await this.pickModel());
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
      const detail = error instanceof Error
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

  private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models[0];
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
      }

      this.lastHealth = {
        provider: 'copilot',
        state: 'ready',
        detail: `Executed via ${resolvedModel.vendor}/${resolvedModel.family}.`
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
    return [
      'You are Pixel Squad, a routing planner for a multi-agent software factory.',
      'Return valid JSON only with this exact shape:',
      '{"title":"string","summary":"string","assignments":[{"personaId":"string","title":"string","detail":"string","dependsOnPersonaIds":["string"],"requiredSkillIds":["string"],"progressLabel":"string"}]}',
      'Do not include markdown fences or commentary.',
      `Available personas: ${describePersonasForPrompt(personas)}.`,
      `Workspace branch: ${workspaceContext.branch || 'unknown'}.`,
      `Active file: ${workspaceContext.activeFile || 'none'}.`,
      `Selected text: ${workspaceContext.selectedText || 'none'}.`,
      `Git status: ${(workspaceContext.gitStatus ?? []).join(' | ') || 'clean or unavailable'}.`,
      `Relevant files:\n${this.describeRelevantFiles(workspaceContext)}`,
      'Use exactly 1 assignment for simple, single-component tasks. Only use 2-3 assignments when the work genuinely spans multiple independent components that cannot be done by one agent. When in doubt, use 1. Prefer direct action, not splitting.',
      'If one assignment must happen after another, populate dependsOnPersonaIds with the personaId it depends on.',
      'Choose requiredSkillIds only from the listed persona skills.',
      'Set progressLabel to a short stage summary such as Ready to start, Waiting on prior task, or Review ready.',
      `User task: ${prompt}`,
    ].join(' ');
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
