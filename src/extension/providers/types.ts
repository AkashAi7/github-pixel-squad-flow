import type { AgentMessage, HandoffPacket, PersonaTemplate, Provider, ProviderHealth, Room, SquadAgent, TaskCard, TaskExecutionPlan, WorkspaceContext } from '../../shared/model/index.js';

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

/** A single outgoing message the LM wants to send to another agent. */
export interface OutgoingAgentMessage {
  toAgentId: string;
  content: string;
  type?: AgentMessage['type'];
}

export interface ExecutionResult {
  output: string;
  success: boolean;
  plan?: TaskExecutionPlan;
  /** Messages the agent wants to send to other agents (parsed from LM response). */
  outgoingMessages?: OutgoingAgentMessage[];
  /** When true the agent considers this turn its final answer. Defaults to true for backwards compat. */
  done?: boolean;
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
    inboxMessages?: AgentMessage[],
  ): Promise<ExecutionResult>;
}
