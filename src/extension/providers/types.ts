import type { ProviderHealth } from '../../shared/model/index.js';

export interface PersonaAssignment {
  personaId: string;
  title: string;
  detail: string;
}

export interface PlanningResult {
  title: string;
  summary: string;
  assignments: PersonaAssignment[];
  providerDetail: string;
}

export interface ProviderAdapter {
  readonly id: 'claude' | 'copilot';
  getHealth(): ProviderHealth;
}
