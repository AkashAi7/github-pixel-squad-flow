import type { ActivityEntry, AgentMessage, WorkspaceSnapshot } from '../model/index.js';

export interface WebviewReadyMessage {
  type: 'webviewReady';
}

export interface ShowAgentMessage {
  type: 'showAgent';
  agentId: string;
}

export interface FocusAgentChatMessage {
  type: 'focusAgentChat';
  agentId: string;
}

export interface OpenCreateRoomMessage {
  type: 'openCreateRoom';
}

export interface OpenProvisionAgentMessage {
  type: 'openProvisionAgent';
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

export interface ToggleAutoExecuteMessage {
  type: 'toggleAutoExecute';
}

export interface SendAgentPromptMessage {
  type: 'sendAgentPrompt';
  agentId: string;
  prompt: string;
}

export type WebviewMessage =
  | WebviewReadyMessage
  | ShowAgentMessage
  | FocusAgentChatMessage
  | OpenCreateRoomMessage
  | OpenProvisionAgentMessage
  | ResetWorkspaceMessage
  | AgentActionMessage
  | TaskActionMessage
  | PinFilesMessage
  | PinActiveFileMessage
  | RequestWorkspaceFilesMessage
  | ToggleAutoExecuteMessage
  | SendAgentPromptMessage;

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

export interface AgentChatMessage {
  type: 'agentChat';
  message: AgentMessage;
}

export interface WorkspaceFilesMessage {
  type: 'workspaceFiles';
  files: string[];
}

export interface TaskStreamChunkMessage {
  type: 'taskChunk';
  taskId: string;
  chunk: string;
}

export type ExtensionMessage = BootstrapStateMessage | ActivityMessage | TaskOutputMessage | AgentChatMessage | WorkspaceFilesMessage | TaskStreamChunkMessage;
