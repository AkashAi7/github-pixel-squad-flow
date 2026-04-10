export type AgentStatus = 'idle' | 'planning' | 'executing' | 'waiting' | 'blocked';
export type TaskStatus = 'queued' | 'active' | 'review' | 'done';

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
  provider: 'claude' | 'copilot';
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
  provider: 'claude' | 'copilot';
  source: 'factory' | 'copilot-chat';
  detail: string;
}

export interface ProviderHealth {
  provider: 'claude' | 'copilot';
  state: 'ready' | 'stub';
  detail: string;
}

export interface WorkspaceSnapshot {
  projectName: string;
  rooms: Room[];
  personas: PersonaTemplate[];
  agents: SquadAgent[];
  tasks: TaskCard[];
  providers: ProviderHealth[];
  activityFeed: string[];
}
