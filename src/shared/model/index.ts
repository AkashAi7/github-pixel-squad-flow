/* ── Core enums ─────────────────────────────────────────── */

export type Provider = 'copilot' | 'claude';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'waiting' | 'blocked' | 'paused' | 'completed' | 'failed';
export type TaskStatus = 'queued' | 'active' | 'review' | 'done' | 'failed';
export type TaskSource = 'factory' | 'copilot-chat' | 'claude-chat';
export type ProviderState = 'ready' | 'unavailable';
export type RoomTheme = 'frontend' | 'backend' | 'devops' | 'testing' | 'design' | 'general';
export type ActivityCategory = 'system' | 'task' | 'agent' | 'provider' | 'agent-chat';
export type ApprovalState = 'pending' | 'applied' | 'rejected';
export type FileEditAction = 'create' | 'replace';
export type CommandExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type RunStatus = 'queued' | 'active' | 'review' | 'done' | 'failed';
export type AgentSessionStatus = 'queued' | 'active' | 'review' | 'done' | 'failed';
export type AgentSessionMessageRole = 'user' | 'agent' | 'system';

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
  skills?: AgentSkill[];
  isCustom?: boolean;
}

export interface CustomPersonaDraft {
  title: string;
  specialty: string;
  color: string;
  skills?: AgentSkill[];
}

export interface AgentSkill {
  id: string;
  label: string;
  level: number;
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
  /** Workspace-relative file paths pinned to this agent for extra context. */
  pinnedFiles?: string[];
}

/* ── Mood system ───────────────────────────────────────── */

export const AGENT_MOOD: Record<AgentStatus, { emoji: string; label: string }> = {
  idle:      { emoji: '😴', label: 'Chilling' },
  planning:  { emoji: '🤔', label: 'Thinking' },
  executing: { emoji: '💪', label: 'Working' },
  waiting:   { emoji: '☕', label: 'On break' },
  blocked:   { emoji: '😰', label: 'Stuck' },
  paused:    { emoji: '⏸️', label: 'Paused' },
  completed: { emoji: '🎉', label: 'Done!' },
  failed:    { emoji: '😵', label: 'Oops' },
};

export interface Room {
  id: string;
  name: string;
  theme: RoomTheme;
  purpose: string;
  color: string;
  agentIds: string[];
}

/* ── Agent Mailbox types ──────────────────────────────── */

export type AgentMessageType = 'request' | 'inform' | 'query' | 'response';

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  roomId: string;
  type: AgentMessageType;
  content: string;
  taskId?: string;
  timestamp: number;
  read?: boolean;
}

/* ── Handoff packets ─────────────────────────────────── */

export interface HandoffPacket {
  fromTaskId: string;
  fromAgentName: string;
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  testsRun: string[];
  openIssues: string[];
  output: string;
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
  dependsOn?: string[];
  requiredSkillIds?: string[];
  progress?: TaskProgress;
  workspaceContext?: WorkspaceContext;
  executionPlan?: TaskExecutionPlan;
  approvalState?: ApprovalState;
  handoffPackets?: HandoffPacket[];
  /** Groups tasks created in the same planning call so completion can be batched. */
  batchId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface WorkspaceContext {
  workspaceRoot?: string;
  branch?: string;
  gitStatus?: string[];
  activeFile?: string;
  selectedText?: string;
  contextMode?: 'light' | 'full';
  relevantFiles: WorkspaceFileContext[];
}

export interface WorkspaceFileContext {
  path: string;
  reason: string;
  content: string;
}

export interface TaskExecutionPlan {
  summary: string;
  fileEdits: ProposedFileEdit[];
  terminalCommands: ProposedTerminalCommand[];
  commandResults: CommandExecutionResult[];
  tests: string[];
  notes: string[];
}

export interface ProposedFileEdit {
  filePath: string;
  action: FileEditAction;
  summary: string;
  originalContent?: string;
  content: string;
}

export interface ProposedTerminalCommand {
  command: string;
  summary: string;
}

export interface CommandExecutionResult {
  commandIndex: number;
  command: string;
  summary: string;
  status: CommandExecutionStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface TaskProgress {
  value: number;
  total: number;
  label: string;
}

export interface ProviderHealth {
  provider: Provider;
  state: ProviderState;
  detail: string;
}

export interface SquadSettings {
  autoExecute: boolean;
  modelFamily: string;
  autoPopulateWorkspaceContext: boolean;
  workspaceContextMaxFiles: number;
}

export interface WorkspaceUiState {
  activeAgentId?: string;
  activeBatchId?: string;
}

export interface RunStage {
  id: string;
  taskId: string;
  title: string;
  detail: string;
  status: TaskStatus;
  agentId: string;
  provider: Provider;
  source: TaskSource;
  dependsOnTaskIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  title: string;
  summary: string;
  status: RunStatus;
  source: TaskSource;
  createdAt: number;
  updatedAt: number;
  stages: RunStage[];
  activeAgentIds: string[];
}

export interface AgentSessionMessage {
  id: string;
  role: AgentSessionMessageRole;
  content: string;
  timestamp: number;
  taskId?: string;
}

export interface AgentSession {
  id: string;
  runId: string;
  agentId: string;
  personaId: string;
  provider: Provider;
  status: AgentSessionStatus;
  startedAt: number;
  updatedAt: number;
  messageLog: AgentSessionMessage[];
}

export interface ActivityEntry {
  id: string;
  category: ActivityCategory;
  message: string;
  timestamp: number;
  taskId?: string;
  agentId?: string;
  roomId?: string;
  provider?: Provider;
}

export interface WorkspaceSnapshot {
  projectName: string;
  rooms: Room[];
  personas: PersonaTemplate[];
  agents: SquadAgent[];
  tasks: TaskCard[];
  runs: RunRecord[];
  agentSessions: AgentSession[];
  providers: ProviderHealth[];
  activityFeed: ActivityEntry[];
  settings: SquadSettings;
  ui: WorkspaceUiState;
}

export function createActivityEntry(
  message: string,
  category: ActivityCategory,
  details: Partial<Omit<ActivityEntry, 'id' | 'category' | 'message' | 'timestamp'>> & {
    id?: string;
    timestamp?: number;
  } = {},
): ActivityEntry {
  return {
    id: details.id ?? `activity-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    category,
    message,
    timestamp: details.timestamp ?? Date.now(),
    taskId: details.taskId,
    agentId: details.agentId,
    roomId: details.roomId,
    provider: details.provider,
  };
}
