export type AgentStatus = 'idle' | 'planning' | 'executing' | 'waiting' | 'blocked' | 'paused' | 'completed' | 'failed';
export type TaskStatus = 'queued' | 'active' | 'review' | 'done' | 'failed';
export type ProviderState = 'ready' | 'unavailable';

export interface PersonaTemplate {
  id: string;
  title: string;
  specialty: string;
  color: string;
}

export interface SquadAgent {
  id: string;
  name: string;
  personaId: string;
  provider: 'copilot';
  status: AgentStatus;
  roomId: string;
  summary: string;
}

export interface Room {
  id: string;
  name: string;
  theme: string;
  purpose: string;
  agentIds: string[];
}

export interface TaskCard {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId: string;
  provider: 'copilot';
  source: 'factory' | 'copilot-chat';
  detail: string;
  output?: string;
}

export interface ProviderHealth {
  provider: 'copilot';
  state: ProviderState;
  detail: string;
}

export interface SquadSettings {
  autoExecute: boolean;
  modelFamily: string;
}

export interface WorkspaceSnapshot {
  projectName: string;
  rooms: Room[];
  personas: PersonaTemplate[];
  agents: SquadAgent[];
  tasks: TaskCard[];
  providers: ProviderHealth[];
  activityFeed: string[];
  settings: SquadSettings;
}
