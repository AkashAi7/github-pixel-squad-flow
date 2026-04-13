import * as vscode from 'vscode';

import type { PersonaTemplate, ProviderHealth, SquadAgent, TaskCard } from '../../../shared/model/index.js';
import type { ExecutionResult, PersonaAssignment, PlanningResult, ProviderAdapter } from '../types.js';
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
        [vscode.LanguageModelChatMessage.User(this.buildPrompt(prompt, personas))],
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
    model?: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
  ): Promise<ExecutionResult> {
    const resolvedModel = model ?? (await this.pickModel());
    if (!resolvedModel) {
      return {
        output: `[Local fallback] Agent ${agent.name} (${persona.title}) completed task "${task.title}" using deterministic analysis.\n\nKey steps:\n1. Reviewed the task scope: ${task.detail}\n2. Identified implementation approach\n3. Prepared deliverables for review\n\nResult: Task ready for team review.`,
        success: true,
      };
    }

    try {
      const prompt = [
        `You are ${agent.name}, a ${persona.specialty} agent in a multi-agent software factory called Pixel Squad.`,
        `Your role: ${persona.title}.`,
        `Execute this task concisely:`,
        `Task: ${task.title}`,
        `Details: ${task.detail}`,
        '',
        'Provide a clear, actionable implementation summary (3-8 bullet points).',
        'Include specific code suggestions, file changes, or architectural decisions as appropriate.',
        'Be direct and practical.',
      ].join('\n');

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

      return { output: text.trim(), success: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      return {
        output: `Execution failed: ${detail}. Agent ${agent.name} could not complete "${task.title}".`,
        success: false,
      };
    }
  }

  private buildPrompt(prompt: string, personas: PersonaTemplate[]): string {
    return [
      'You are Pixel Squad, a routing planner for a multi-agent software factory.',
      'Return valid JSON only with this exact shape:',
      '{"title":"string","summary":"string","assignments":[{"personaId":"string","title":"string","detail":"string","dependsOnPersonaIds":["string"],"requiredSkillIds":["string"],"progressLabel":"string"}]}',
      'Do not include markdown fences or commentary.',
      `Available personas: ${describePersonasForPrompt(personas)}.`,
      'Use 1 to 3 assignments max. Prefer concrete software implementation tasks.',
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
}
