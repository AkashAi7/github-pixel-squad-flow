import type { ActivityEntry, AgentMessage, CustomPersonaDraft, Provider, RoomTheme, WorkspaceSnapshot } from '../model/index.js';

export interface WebviewReadyMessage {
  type: 'webviewReady';
}

export interface ShowAgentMessage {
  type: 'showAgent';
  agentId: string;
}

export interface CreateTaskMessage {
  type: 'createTask';
  prompt: string;
}

export interface ResetWorkspaceMessage {
  type: 'resetWorkspace';
}

export interface AgentActionMessage {
  type: 'agentAction';
  agentId: string;
  action: 'pause' | 'resume' | 'complete' | 'retry';
}

export interface TaskActionMessage {
  type: 'taskAction';
  taskId: string;
  action: 'execute' | 'complete' | 'fail' | 'retry' | 'run';
}

/* ── Room CRUD ─────────────────────────────────────────── */

export interface CreateRoomMessage {
  type: 'createRoom';
  name: string;
  theme: RoomTheme;
  purpose: string;
}

export interface DeleteRoomMessage {
  type: 'deleteRoom';
  roomId: string;
}

/* ── Agent spawning ────────────────────────────────────── */

export interface SpawnAgentMessage {
  type: 'spawnAgent';
  roomId: string;
  name: string;
  personaId: string;
  provider: Provider;
  customPersona?: CustomPersonaDraft;
}

export interface RemoveAgentMessage {
  type: 'removeAgent';
  agentId: string;
}

export interface AssignTaskMessage {
  type: 'assignTask';
  agentId: string;
  prompt: string;
}

export interface PinFilesMessage {
  type: 'pinFiles';
  agentId: string;
  files: string[];
}

export interface PinActiveFileMessage {
  type: 'pinActiveFile';
  agentId: string;
}

export interface RequestWorkspaceFilesMessage {
  type: 'requestWorkspaceFiles';
}

export type WebviewMessage =
  | WebviewReadyMessage
  | ShowAgentMessage
  | CreateTaskMessage
  | ResetWorkspaceMessage
  | AgentActionMessage
  | TaskActionMessage
  | CreateRoomMessage
  | DeleteRoomMessage
  | SpawnAgentMessage
  | RemoveAgentMessage
  | AssignTaskMessage
  | PinFilesMessage
  | PinActiveFileMessage
  | RequestWorkspaceFilesMessage;

export interface BootstrapStateMessage {
  type: 'bootstrapState';
  snapshot: WorkspaceSnapshot;
}

export interface ActivityMessage {
  type: 'activity';
  message: string;
  activity: ActivityEntry;
}

export interface TaskOutputMessage {
  type: 'taskOutput';
  taskId: string;
  output: string;
}

export interface AssignAckMessage {
  type: 'assignAck';
  agentId: string;
  taskId: string;
}

export interface AgentChatMessage {
  type: 'agentChat';
  message: AgentMessage;
}

export interface WorkspaceFilesMessage {
  type: 'workspaceFiles';
  files: string[];
}

export type ExtensionMessage = BootstrapStateMessage | ActivityMessage | TaskOutputMessage | AssignAckMessage | AgentChatMessage | WorkspaceFilesMessage;
