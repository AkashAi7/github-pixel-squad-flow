import * as fs from 'node:fs';
import * as vscode from 'vscode';

import { Coordinator } from './coordinator/Coordinator.js';
import type { AgentSession, Provider, RoomTheme, RunRecord, SquadAgent, TaskCard } from '../shared/model/index.js';
import type { ExtensionMessage, WebviewMessage } from '../shared/protocol/messages.js';

export const VIEW_ID = 'pixelSquad.factoryView';

export class PixelSquadViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly coordinator: Coordinator;
  private staleReaperTimer?: ReturnType<typeof setInterval>;
  private readonly messageSinks = new Set<(msg: ExtensionMessage) => void>();

  constructor(private readonly extensionUri: vscode.Uri) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.coordinator = new Coordinator(workspaceRoot);
    // Periodically check for stale tasks every 30s
    this.staleReaperTimer = setInterval(() => {
      const reaped = this.coordinator.reapStaleTasks();
      if (reaped > 0) { this.syncSnapshot(); }
    }, 30_000);
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
    const sink = (msg: ExtensionMessage) => void webviewView.webview.postMessage(msg);
    this.messageSinks.add(sink);

    const unsubscribe = this.coordinator.activityBus.subscribe((message) => {
      this.postMessage(message);
    });

    const unsubOutput = this.coordinator.taskOutputBus.subscribe((message) => {
      this.postMessage(message);
    });

    const unsubChat = this.coordinator.agentChatBus.subscribe((message) => {
      this.postMessage(message);
    });

    const unsubStream = this.coordinator.streamBus.subscribe((message) => {
      this.postMessage(message);
    });

    webviewView.onDidDispose(() => {
      this.messageSinks.delete(sink);
      unsubscribe();
      unsubOutput();
      unsubChat();
      unsubStream();
    });

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleWebviewMessage(message, () => this.syncSnapshot(), (msg) => this.postMessage(msg));
    });
  }

  /** Open Pixel Squad Flow as a full editor-area panel — more space, sits alongside Copilot Chat */
  openAsEditorPanel(): void {
    const panel = vscode.window.createWebviewPanel(
      'pixelSquad.editorPanel',
      'Pixel Squad Flow',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(vscode.Uri.file(this.extensionUri.fsPath), 'dist', 'webview')
        ],
      }
    );

    panel.webview.html = this.getHtml(panel.webview);

    const post = (msg: ExtensionMessage) => void panel.webview.postMessage(msg);
  this.messageSinks.add(post);
    const sync = () => post({ type: 'bootstrapState', snapshot: this.coordinator.getSnapshot() });

    const unsubActivity = this.coordinator.activityBus.subscribe(post);
    const unsubOutput = this.coordinator.taskOutputBus.subscribe(post);
    const unsubChat = this.coordinator.agentChatBus.subscribe(post);
    const unsubStream = this.coordinator.streamBus.subscribe(post);

    panel.onDidDispose(() => {
      this.messageSinks.delete(post);
      unsubActivity();
      unsubOutput();
      unsubChat();
      unsubStream();
    });

    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleWebviewMessage(message, sync, post);
    });

    sync();
  }

  private async handleWebviewMessage(
    message: WebviewMessage,
    syncSnapshot: () => void,
    postMessage: (msg: ExtensionMessage) => void,
  ): Promise<void> {
    if (message.type === 'webviewReady') {
      this.coordinator.notifyWebviewConnected();
      syncSnapshot();
    }

    if (message.type === 'showAgent') {
      this.coordinator.selectAgent(message.agentId);
      syncSnapshot();
    }

    if (message.type === 'focusAgentChat') {
      this.coordinator.selectAgent(message.agentId);
      await this.openAgentChat(message.agentId);
      syncSnapshot();
    }

    if (message.type === 'openCreateRoom') {
      await vscode.commands.executeCommand('pixelSquad.createRoom');
      syncSnapshot();
    }

    if (message.type === 'openProvisionAgent') {
      await vscode.commands.executeCommand('pixelSquad.spawnAgent');
      syncSnapshot();
    }

    if (message.type === 'resetWorkspace') {
      this.coordinator.resetWorkspace();
      syncSnapshot();
    }

    if (message.type === 'agentAction') {
      this.coordinator.agentAction(message.agentId, message.action);
      syncSnapshot();
    }

    if (message.type === 'taskAction') {
      try {
        await this.coordinator.taskAction(message.taskId, message.action);
      } catch {
        // taskAction failure — still sync state
      }
      syncSnapshot();
    }

    if (message.type === 'pinFiles') {
      this.coordinator.pinFiles(message.agentId, message.files);
      syncSnapshot();
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
          syncSnapshot();
        }
      }
    }

    if (message.type === 'requestWorkspaceFiles') {
      const files = await this.coordinator.getWorkspaceFiles();
      postMessage({ type: 'workspaceFiles', files });
    }

    if (message.type === 'toggleAutoExecute') {
      const config = vscode.workspace.getConfiguration('pixelSquad');
      const current = config.get<boolean>('autoExecute', false);
      await config.update('autoExecute', !current, vscode.ConfigurationTarget.Workspace);
      syncSnapshot();
    }

    if (message.type === 'sendAgentPrompt') {
      await this.coordinator.continueAgentSession(message.agentId, message.prompt);
      syncSnapshot();
    }

  }

  private postMessage(message: ExtensionMessage): void {
    for (const sink of this.messageSinks) {
      sink(message);
    }
  }

  async createTaskFromPrompt(
    prompt: string,
    model?: vscode.LanguageModelChat,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    const summary = await this.coordinator.createTask(prompt, model, token, 'copilot', 'copilot-chat');
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
    return `Smoke test passed through Pixel Squad Flow routing. ${summary}`;
  }

  /** Return agents list for CLI QuickPick */
  getAgents(): Array<{ id: string; name: string; status: string; provider: string; persona: string }> {
    const snap = this.coordinator.getSnapshot();
    return snap.agents.map((a) => {
      const persona = snap.personas.find((p) => p.id === a.personaId);
      return { id: a.id, name: a.name, status: a.status, provider: a.provider, persona: persona?.title ?? a.personaId };
    });
  }

  getRooms(): Array<{ id: string; name: string; theme: string; purpose: string; agentCount: number }> {
    const snap = this.coordinator.getSnapshot();
    return snap.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      theme: room.theme,
      purpose: room.purpose,
      agentCount: room.agentIds.length,
    }));
  }

  getPersonas(): Array<{ id: string; title: string; specialty: string }> {
    const snap = this.coordinator.getSnapshot();
    return snap.personas.map((persona) => ({
      id: persona.id,
      title: persona.title,
      specialty: persona.specialty,
    }));
  }

  createRoom(name: string, theme: RoomTheme, purpose: string): string {
    const room = this.coordinator.createRoom(name, theme, purpose);
    this.syncSnapshot();
    return `Room created: ${room.name} (${room.theme}).`;
  }

  spawnAgent(roomId: string, name: string, personaId: string, provider: Provider): string {
    const agent = this.coordinator.spawnAgent(roomId, name, personaId, provider);
    this.syncSnapshot();
    return agent
      ? `Provisioned ${agent.name} in room ${roomId}.`
      : 'Unable to provision agent.';
  }

  refresh(): void {
    this.syncSnapshot();
  }

  /** Assign a task to a specific agent (CLI entry point) */
  async assignTaskToAgent(agentId: string, prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const summary = await this.coordinator.assignTask(agentId, prompt, model, token);
    this.syncSnapshot();
    return summary;
  }

  async assignTaskToPersona(personaId: string, prompt: string, provider?: Provider, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const summary = await this.coordinator.assignTaskToPersona(personaId, prompt, provider, model, token, 'copilot-chat');
    this.syncSnapshot();
    return summary;
  }

  /** Fleet mode: execute a prompt across all idle agents in parallel */
  async fleetExecute(prompt: string): Promise<string> {
    const summary = await this.coordinator.fleetExecute(prompt);
    this.syncSnapshot();
    return summary;
  }

  dispose(): void {
    if (this.staleReaperTimer) { clearInterval(this.staleReaperTimer); }
    this.coordinator.dispose();
  }

  private syncSnapshot(): void {
    this.postMessage({
      type: 'bootstrapState',
      snapshot: this.coordinator.getSnapshot(),
    });
  }

  private pickFocusTask(tasks: TaskCard[], agentId: string): TaskCard | undefined {
    const agentTasks = tasks
      .filter((task) => task.assigneeId === agentId)
      .sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0));
    return agentTasks.find((task) => task.status === 'active')
      ?? agentTasks.find((task) => task.status === 'review')
      ?? agentTasks.find((task) => task.status === 'queued')
      ?? agentTasks[0];
  }

  private pickAgentSession(agentId: string, runId: string | undefined): AgentSession | undefined {
    const sessions = this.coordinator.getSnapshot().agentSessions;
    return sessions.find((session) => session.agentId === agentId && session.runId === runId)
      ?? sessions.find((session) => session.agentId === agentId);
  }

  private buildAgentChatPrompt(agent: SquadAgent, focusTask: TaskCard | undefined, run: RunRecord | undefined): string {
    const snapshot = this.coordinator.getSnapshot();
    const session = this.pickAgentSession(agent.id, run?.id ?? focusTask?.batchId);
    const latestAgentReply = session?.messageLog
      .filter((message) => message.role === 'agent')
      .at(-1)?.content;
    const fileTargets = Array.from(new Set([
      ...(focusTask?.executionPlan?.fileEdits.map((edit) => edit.filePath) ?? []),
      ...(agent.pinnedFiles ?? []),
      ...(focusTask?.workspaceContext?.activeFile ? [focusTask.workspaceContext.activeFile] : []),
    ])).slice(0, 6);
    const persona = snapshot.personas.find((item) => item.id === agent.personaId);

    return [
      `@pixel-squad /${agent.personaId} Continue ${agent.name}'s current runtime.`,
      run ? `Run: ${run.title}` : '',
      focusTask ? `Current task: ${focusTask.title}` : '',
      focusTask?.detail ? `Task details: ${focusTask.detail}` : '',
      fileTargets.length > 0 ? `Focus files: ${fileTargets.join(', ')}` : '',
      latestAgentReply ? `Latest lane output: ${latestAgentReply.slice(0, 500)}` : '',
      persona ? `Stay in the ${persona.title} lane.` : '',
      'If a named file already exists, update it directly instead of replying with only a plan.',
    ].filter(Boolean).join('\n');
  }

  private async openAgentChat(agentId: string): Promise<void> {
    const snapshot = this.coordinator.getSnapshot();
    const agent = snapshot.agents.find((item) => item.id === agentId);
    if (!agent) {
      return;
    }

    const focusTask = this.pickFocusTask(snapshot.tasks, agentId);
    const runId = snapshot.ui.activeBatchId && snapshot.runs.some((run) => run.id === snapshot.ui.activeBatchId && run.activeAgentIds.includes(agentId))
      ? snapshot.ui.activeBatchId
      : focusTask?.batchId;
    const run = runId ? snapshot.runs.find((item) => item.id === runId) : undefined;
    const prompt = this.buildAgentChatPrompt(agent, focusTask, run);

    await vscode.env.clipboard.writeText(prompt);

    const attempts: Array<() => Thenable<unknown>> = [
      () => vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true }),
      () => vscode.commands.executeCommand('workbench.action.chat.open', prompt),
      () => vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus'),
      () => vscode.commands.executeCommand('github.copilot.chat.focus'),
    ];

    for (const attempt of attempts) {
      try {
        await attempt();
        vscode.window.setStatusBarMessage('$(comment-discussion) Pixel Squad copied the lane prompt. If Copilot Chat did not prefill it, paste from clipboard.', 5000);
        return;
      } catch {
        // Try the next chat-open path.
      }
    }

    void vscode.window.showInformationMessage('Pixel Squad copied the lane prompt. Open GitHub Copilot Chat and paste to continue this runtime.');
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
    <title>Pixel Squad Flow</title>
    <style>
      body { font-family: sans-serif; padding: 24px; background: #101820; color: #f7f3e9; }
      strong { color: #ffe066; }
    </style>
  </head>
  <body>
    <strong>Pixel Squad Flow webview has not been built yet.</strong>
    <p>Run the webview build to replace this fallback with the factory UI.</p>
  </body>
</html>`;
  }
}
