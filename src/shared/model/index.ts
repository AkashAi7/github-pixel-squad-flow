/* ── Core enums ─────────────────────────────────────────── */

export type Provider = 'copilot' | 'claude';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'waiting' | 'blocked' | 'paused' | 'completed' | 'failed';
export type TaskStatus = 'queued' | 'active' | 'review' | 'done' | 'failed';
export type TaskSource = 'factory' | 'copilot-chat' | 'claude-chat';
export type ProviderState = 'ready' | 'unavailable';
export type RoomTheme = 'frontend' | 'backend' | 'devops' | 'testing' | 'design' | 'general';

/* ── Room theme palette ────────────────────────────────── */

export const ROOM_THEME_META: Record<RoomTheme, { label: string; color: string; icon: string }> = {
  frontend: { label: 'Frontend Lab', color: '#f25f5c', icon: '⚛' },
  backend:  { label: 'Backend Engine', color: '#247ba0', icon: '⚙' },
  devops:   { label: 'DevOps Pit', color: '#8d6e63', icon: '🚀' },
  testing:  { label: 'QA Chamber', color: '#70c1b3', icon: '🧪' },
  design:   { label: 'Design Studio', color: '#ce93d8', icon: '🎨' },
  general:  { label: 'War Room', color: '#ffe066', icon: '📋' },
};

/* ── Domain interfaces ────────────────────────────────── */

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
  provider: Provider;
  status: AgentStatus;
  roomId: string;
  summary: string;
  spriteVariant: number;
}

export interface Room {
  id: string;
  name: string;
  theme: RoomTheme;
  purpose: string;
  color: string;
  agentIds: string[];
}

export interface TaskCard {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId: string;
  provider: Provider;
  source: TaskSource;
  detail: string;
  output?: string;
}

export interface ProviderHealth {
  provider: Provider;
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
