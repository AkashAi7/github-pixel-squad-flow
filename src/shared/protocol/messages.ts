import type { WorkspaceSnapshot } from '../model/index.js';

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
  action: 'execute' | 'complete' | 'fail' | 'retry';
}

export type WebviewMessage =
  | WebviewReadyMessage
  | ShowAgentMessage
  | CreateTaskMessage
  | ResetWorkspaceMessage
  | AgentActionMessage
  | TaskActionMessage;

export interface BootstrapStateMessage {
  type: 'bootstrapState';
  snapshot: WorkspaceSnapshot;
}

export interface ActivityMessage {
  type: 'activity';
  message: string;
}

export interface TaskOutputMessage {
  type: 'taskOutput';
  taskId: string;
  output: string;
}

export type ExtensionMessage = BootstrapStateMessage | ActivityMessage | TaskOutputMessage;
