import * as vscode from 'vscode';

import type { PersonaTemplate, ProviderHealth } from '../../../shared/model/index.js';
import type { PersonaAssignment, PlanningResult, ProviderAdapter } from '../types.js';

export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot';
  private lastHealth: ProviderHealth = {
    provider: 'copilot',
    state: 'stub',
    detail: 'GitHub-model orchestration will be owned by Pixel Squad first; native Copilot mirroring stays experimental.'
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

  private buildPrompt(prompt: string, personas: PersonaTemplate[]): string {
    return [
      'You are Pixel Squad, a routing planner for a multi-agent software factory.',
      'Return valid JSON only with this exact shape:',
      '{"title":"string","summary":"string","assignments":[{"personaId":"string","title":"string","detail":"string"}]}',
      'Do not include markdown fences or commentary.',
      `Available personas: ${personas.map((persona) => `${persona.id} (${persona.title}: ${persona.specialty})`).join(', ')}.`,
      'Use 1 to 3 assignments max. Prefer concrete software implementation tasks.',
      `User task: ${prompt}`,
    ].join(' ');
  }

  private parsePlan(text: string, personas: PersonaTemplate[]): PlanningResult {
    const normalized = text.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const raw = JSON.parse(normalized) as {
      title?: string;
      summary?: string;
      assignments?: Array<{ personaId?: string; title?: string; detail?: string }>;
    };

    const personaIds = new Set(personas.map((persona) => persona.id));
    const assignments = (raw.assignments ?? [])
      .filter((item) => item.personaId && item.title && item.detail && personaIds.has(item.personaId))
      .slice(0, 3)
      .map((item) => ({
        personaId: item.personaId!,
        title: item.title!,
        detail: item.detail!,
      }));

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
    const lower = prompt.toLowerCase();
    const assignments: PersonaAssignment[] = [];
    const has = (value: string): boolean => lower.includes(value);
    const ensure = (personaId: string, title: string, itemDetail: string): void => {
      if (assignments.some((assignment) => assignment.personaId === personaId)) {
        return;
      }
      if (!personas.some((persona) => persona.id === personaId)) {
        return;
      }
      assignments.push({ personaId, title, detail: itemDetail });
    };

    ensure('lead', 'Shape the delivery plan', `Break down the request and coordinate the next moves for: ${prompt}`);
    if (has('ui') || has('frontend') || has('webview') || has('design')) {
      ensure('frontend', 'Build the interface slice', 'Implement the visible user experience and wire it to the current state model.');
    }
    if (has('api') || has('backend') || has('persist') || has('data') || assignments.length < 2) {
      ensure('backend', 'Implement the runtime changes', 'Update the extension host, persistence, or provider code to support the requested behavior.');
    }
    if (has('test') || has('verify') || assignments.length < 3) {
      ensure('tester', 'Validate the flow', 'Check error handling, smoke-test the feature, and document any remaining gaps.');
    }

    return {
      title: prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt,
      summary: 'Pixel Squad generated a deterministic routing plan because a live GitHub Copilot model was unavailable or failed.',
      assignments: assignments.slice(0, 3),
      providerDetail: detail,
    };
  }
}
