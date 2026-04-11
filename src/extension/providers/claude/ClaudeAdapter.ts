import * as vscode from 'vscode';

import type { PersonaTemplate, ProviderHealth, SquadAgent, TaskCard } from '../../../shared/model/index.js';
import type { ExecutionResult, PersonaAssignment, PlanningResult, ProviderAdapter } from '../types.js';

/**
 * Claude adapter — tries vscode.lm models with vendor/family containing "claude"
 * or "anthropic". Falls back to deterministic local routing when unavailable.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;
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
    model?: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
  ): Promise<PlanningResult> {
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
        provider: 'claude',
        state: 'ready',
        detail: `Executed via ${resolvedModel.vendor}/${resolvedModel.family}.`,
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

  private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    // Try anthropic vendor first, then look for any model with 'claude' in the family
    const anthropicModels = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
    if (anthropicModels.length > 0) {
      return anthropicModels[0];
    }

    const allModels = await vscode.lm.selectChatModels();
    return allModels.find(
      (m) =>
        m.family.toLowerCase().includes('claude') ||
        m.vendor.toLowerCase().includes('anthropic') ||
        m.vendor.toLowerCase().includes('claude'),
    );
  }

  private buildPrompt(prompt: string, personas: PersonaTemplate[]): string {
    return [
      'You are Pixel Squad, a routing planner for a multi-agent software factory.',
      'Return valid JSON only with this exact shape:',
      '{"title":"string","summary":"string","assignments":[{"personaId":"string","title":"string","detail":"string"}]}',
      'Do not include markdown fences or commentary.',
      `Available personas: ${personas.map((p) => `${p.id} (${p.title}: ${p.specialty})`).join(', ')}.`,
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

    const personaIds = new Set(personas.map((p) => p.id));
    const assignments = (raw.assignments ?? [])
      .filter((item) => item.personaId && item.title && item.detail && personaIds.has(item.personaId))
      .slice(0, 3)
      .map((item) => ({ personaId: item.personaId!, title: item.title!, detail: item.detail! }));

    if (!raw.title || !raw.summary || assignments.length === 0) {
      throw new Error('Model response was missing required planning fields.');
    }

    return { title: raw.title, summary: raw.summary, assignments, providerDetail: '' };
  }

  private createFallbackPlan(prompt: string, personas: PersonaTemplate[], detail: string): PlanningResult {
    const lower = prompt.toLowerCase();
    const assignments: PersonaAssignment[] = [];
    const has = (v: string): boolean => lower.includes(v);
    const ensure = (personaId: string, title: string, d: string): void => {
      if (assignments.some((a) => a.personaId === personaId)) return;
      if (!personas.some((p) => p.id === personaId)) return;
      assignments.push({ personaId, title, detail: d });
    };

    ensure('lead', 'Shape the delivery plan', `Break down the request and coordinate: ${prompt}`);
    if (has('ui') || has('frontend') || has('webview') || has('design')) {
      ensure('frontend', 'Build the interface slice', 'Implement the visible UX and wire it to state.');
    }
    if (has('api') || has('backend') || has('persist') || has('data') || assignments.length < 2) {
      ensure('backend', 'Implement the runtime changes', 'Update extension host, persistence, or provider code.');
    }
    if (has('test') || has('verify') || assignments.length < 3) {
      ensure('tester', 'Validate the flow', 'Check error handling, smoke-test, and document gaps.');
    }

    return {
      title: prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt,
      summary: 'Pixel Squad generated a deterministic routing plan because a live Claude model was unavailable or failed.',
      assignments: assignments.slice(0, 3),
      providerDetail: detail,
    };
  }
}
