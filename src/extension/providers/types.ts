import type { HandoffPacket, PersonaTemplate, Provider, ProviderHealth, Room, SquadAgent, TaskCard, TaskExecutionPlan, WorkspaceContext } from '../../shared/model/index.js';

export interface PersonaAssignment {
  personaId: string;
  title: string;
  detail: string;
  dependsOnPersonaIds?: string[];
  requiredSkillIds?: string[];
  progressLabel?: string;
}

export interface PlanningResult {
  title: string;
  summary: string;
  assignments: PersonaAssignment[];
  providerDetail: string;
}

export interface ExecutionResult {
  output: string;
  success: boolean;
  plan?: TaskExecutionPlan;
}

export interface ProviderAdapter {
  readonly id: Provider;
  getHealth(): ProviderHealth;
  createPlan(
    prompt: string,
    personas: PersonaTemplate[],
    workspaceContext: WorkspaceContext,
    model?: import('vscode').LanguageModelChat,
    token?: import('vscode').CancellationToken,
  ): Promise<PlanningResult>;
  executeTask(
    task: TaskCard,
    agent: SquadAgent,
    persona: PersonaTemplate,
    workspaceContext: WorkspaceContext,
    model?: import('vscode').LanguageModelChat,
    token?: import('vscode').CancellationToken,
    room?: Room,
    handoffPackets?: HandoffPacket[],
  ): Promise<ExecutionResult>;
}
