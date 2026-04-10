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

export type WebviewMessage =
  | WebviewReadyMessage
  | ShowAgentMessage
  | CreateTaskMessage
  | ResetWorkspaceMessage;

export interface BootstrapStateMessage {
  type: 'bootstrapState';
  snapshot: WorkspaceSnapshot;
}

export interface ActivityMessage {
  type: 'activity';
  message: string;
}

export type ExtensionMessage = BootstrapStateMessage | ActivityMessage;
