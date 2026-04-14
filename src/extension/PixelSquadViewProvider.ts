import * as fs from 'node:fs';
import * as vscode from 'vscode';

import { Coordinator } from './coordinator/Coordinator.js';
import type { ExtensionMessage, WebviewMessage } from '../shared/protocol/messages.js';

export const VIEW_ID = 'pixelSquad.factoryView';

export class PixelSquadViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly coordinator: Coordinator;

  constructor(private readonly extensionUri: vscode.Uri) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.coordinator = new Coordinator(workspaceRoot);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(vscode.Uri.file(this.extensionUri.fsPath), 'dist', 'webview')
      ]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const unsubscribe = this.coordinator.activityBus.subscribe((message) => {
      this.postMessage(message);
    });

    const unsubOutput = this.coordinator.taskOutputBus.subscribe((message) => {
      this.postMessage(message);
    });

    const unsubChat = this.coordinator.agentChatBus.subscribe((message) => {
      this.postMessage(message);
    });

    webviewView.onDidDispose(() => {
      unsubscribe();
      unsubOutput();
      unsubChat();
    });

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.type === 'webviewReady') {
        this.coordinator.notifyWebviewConnected();
        this.syncSnapshot();
      }

      if (message.type === 'showAgent') {
        this.coordinator.selectAgent(message.agentId);
        this.syncSnapshot();
      }

      if (message.type === 'createTask') {
        try {
          const summary = await this.coordinator.createTask(message.prompt);
          this.syncSnapshot();
          void vscode.window.showInformationMessage(summary);
        } catch (error) {
          this.syncSnapshot();
          const detail = error instanceof Error ? error.message : 'Unknown error';
          void vscode.window.showErrorMessage(`Pixel Squad routing failed: ${detail}`);
        }
      }

      if (message.type === 'resetWorkspace') {
        this.coordinator.resetWorkspace();
        this.syncSnapshot();
      }

      if (message.type === 'agentAction') {
        this.coordinator.agentAction(message.agentId, message.action);
        this.syncSnapshot();
      }

      if (message.type === 'taskAction') {
        try {
          await this.coordinator.taskAction(message.taskId, message.action);
        } catch {
          // taskAction failure — still sync state
        }
        this.syncSnapshot();
      }

      if (message.type === 'createRoom') {
        this.coordinator.createRoom(message.name, message.theme, message.purpose);
        this.syncSnapshot();
      }

      if (message.type === 'deleteRoom') {
        this.coordinator.deleteRoom(message.roomId);
        this.syncSnapshot();
      }

      if (message.type === 'spawnAgent') {
        this.coordinator.spawnAgent(message.roomId, message.name, message.personaId, message.provider, message.customPersona);
        this.syncSnapshot();
      }

      if (message.type === 'removeAgent') {
        this.coordinator.removeAgent(message.agentId);
        this.syncSnapshot();
      }

      if (message.type === 'assignTask') {
        try {
          const summary = await this.coordinator.assignTask(message.agentId, message.prompt);
          this.postMessage({ type: 'assignAck', agentId: message.agentId, taskId: '' });
          this.syncSnapshot();
          void vscode.window.showInformationMessage(summary);
        } catch (error) {
          this.postMessage({ type: 'assignAck', agentId: message.agentId, taskId: '' });
          this.syncSnapshot();
          const detail = error instanceof Error ? error.message : 'Unknown error';
          void vscode.window.showErrorMessage(`Task assignment failed: ${detail}`);
        }
      }

      if (message.type === 'pinFiles') {
        this.coordinator.pinFiles(message.agentId, message.files);
        this.syncSnapshot();
      }

      if (message.type === 'pinActiveFile') {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (activeUri && root) {
          const relative = vscode.workspace.asRelativePath(activeUri, false);
          const agent = this.coordinator.getSnapshot().agents.find(a => a.id === message.agentId);
          const current = agent?.pinnedFiles ?? [];
          if (!current.includes(relative)) {
            this.coordinator.pinFiles(message.agentId, [...current, relative]);
            this.syncSnapshot();
          }
        }
      }

      if (message.type === 'requestWorkspaceFiles') {
        const files = await this.coordinator.getWorkspaceFiles();
        this.postMessage({ type: 'workspaceFiles', files });
      }

      if (message.type === 'toggleAutoExecute') {
        const config = vscode.workspace.getConfiguration('pixelSquad');
        const current = config.get<boolean>('autoExecute', false);
        await config.update('autoExecute', !current, vscode.ConfigurationTarget.Workspace);
        this.syncSnapshot();
      }
    });
  }

  private postMessage(message: ExtensionMessage): void {
    this.view?.webview.postMessage(message);
  }

  async createTaskFromPrompt(
    prompt: string,
    model?: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    const summary = await this.coordinator.createTask(prompt, model, token);
    this.syncSnapshot();
    return summary;
  }

  resetWorkspace(): void {
    this.coordinator.resetWorkspace();
    this.syncSnapshot();
  }

  async runSmokeTest(): Promise<string> {
    this.coordinator.resetWorkspace();
    this.syncSnapshot();
    const summary = await this.coordinator.createTask(
      'Build a settings screen, persist the selected theme, and add a tester validation pass.',
    );
    this.syncSnapshot();
    return `Smoke test passed through Pixel Squad routing. ${summary}`;
  }

  /** Return agents list for CLI QuickPick */
  getAgents(): Array<{ id: string; name: string; status: string; provider: string; persona: string }> {
    const snap = this.coordinator.getSnapshot();
    return snap.agents.map((a) => {
      const persona = snap.personas.find((p) => p.id === a.personaId);
      return { id: a.id, name: a.name, status: a.status, provider: a.provider, persona: persona?.title ?? a.personaId };
    });
  }

  refresh(): void {
    this.syncSnapshot();
  }

  /** Assign a task to a specific agent (CLI entry point) */
  async assignTaskToAgent(agentId: string, prompt: string): Promise<string> {
    const summary = await this.coordinator.assignTask(agentId, prompt);
    this.syncSnapshot();
    return summary;
  }

  private syncSnapshot(): void {
    this.postMessage({
      type: 'bootstrapState',
      snapshot: this.coordinator.getSnapshot(),
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(vscode.Uri.file(this.extensionUri.fsPath), 'dist', 'webview');
    const htmlPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

    if (!fs.existsSync(htmlPath)) {
      return this.getFallbackHtml(webview);
    }

    let html = fs.readFileSync(htmlPath, 'utf8');

    // Replace relative asset paths with webview URIs (same approach as pixel-agents)
    html = html.replace(/(href|src)="\.\/(.*?)"/g, (_match, attr, filePath) => {
      const fileUri = vscode.Uri.joinPath(distPath, filePath);
      const webviewUri = webview.asWebviewUri(fileUri);
      return `${attr}="${webviewUri}"`;
    });

    // Strip crossorigin attributes that Vite injects (breaks in webview context)
    html = html.replace(/\s+crossorigin/g, '');

    return html;
  }

  private getFallbackHtml(webview: vscode.Webview): string {
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pixel Squad</title>
    <style>
      body { font-family: sans-serif; padding: 24px; background: #101820; color: #f7f3e9; }
      strong { color: #ffe066; }
    </style>
  </head>
  <body>
    <strong>Pixel Squad webview has not been built yet.</strong>
    <p>Run the webview build to replace this fallback with the factory UI.</p>
  </body>
</html>`;
  }
}
