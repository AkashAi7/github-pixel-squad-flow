import * as fs from 'node:fs';
import * as vscode from 'vscode';

import { Coordinator } from './coordinator/Coordinator.js';
import type { AgentSession, Provider, RoomTheme, RunRecord, SquadAgent, TaskCard } from '../shared/model/index.js';
import { ROOM_THEME_META } from '../shared/model/index.js';
import { discoverExternalTools } from './tools/toolCallLoop.js';
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
      const current = config.get<boolean>('autoExecute', true);
      await config.update('autoExecute', !current, vscode.ConfigurationTarget.Workspace);
      syncSnapshot();
    }

    if (message.type === 'toggleForceMcpForAllTasks') {
      const config = vscode.workspace.getConfiguration('pixelSquad');
      const current = config.get<boolean>('forceMcpForAllTasks', false);
      await config.update('forceMcpForAllTasks', !current, vscode.ConfigurationTarget.Workspace);
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

  /**
   * Chat-side agent provisioning: parse a free-form prompt like
   * `frontend in landing-room as Atlas` and spawn the requested persona.
   * Auto-creates a target room when none exists so the chat flow stays
   * terminal-free for the user.
   */
  provisionAgentFromChat(personaInput: string, prompt: string, provider?: Provider): string {
    const personas = this.coordinator.getSnapshot().personas;
    const normalizedPersona = personaInput.trim().toLowerCase();
    const persona = personas.find((entry) => entry.id.toLowerCase() === normalizedPersona)
      ?? personas.find((entry) => entry.title.toLowerCase() === normalizedPersona);
    if (!persona) {
      const available = personas.map((entry) => entry.id).join(', ');
      return `Could not resolve persona "${personaInput}". Available personas: ${available}.`;
    }

    const promptText = prompt.trim();
    const inMatch = promptText.match(/(?:\bin\s+)([^,\n]+?)(?:$|,|\s+as\s+|\s+named\s+)/i);
    const nameMatch = promptText.match(/(?:\bas\s+|\bnamed\s+)([^,\n]+?)(?:$|,)/i);
    const roomHint = inMatch?.[1]?.trim();
    const agentName = nameMatch?.[1]?.trim() ?? '';

    let room = roomHint
      ? this.coordinator.getSnapshot().rooms.find((entry) => entry.name.toLowerCase() === roomHint.toLowerCase())
      : undefined;
    if (!room) {
      const snapshot = this.coordinator.getSnapshot();
      const preferredThemeByPersona: Partial<Record<string, RoomTheme>> = {
        lead: 'general',
        frontend: 'frontend',
        backend: 'backend',
        tester: 'testing',
        devops: 'devops',
        designer: 'design',
      };
      const preferredTheme = preferredThemeByPersona[persona.id] ?? 'general';
      room = snapshot.rooms.find((entry) => entry.theme === preferredTheme)
        ?? snapshot.rooms.find((entry) => entry.theme === 'general')
        ?? snapshot.rooms[0];
      if (!room) {
        const themeMeta = ROOM_THEME_META[preferredTheme];
        room = this.coordinator.createRoom(themeMeta.label, preferredTheme, `Chat-provisioned ${themeMeta.label} for ${persona.title} work.`);
      }
    }

    if (!room) {
      return `Unable to find or create a room for ${persona.title}.`;
    }

    const selectedProvider = provider ?? (vscode.workspace.getConfiguration('pixelSquad').get<string>('modelFamily', 'copilot') as Provider);
    const agent = this.coordinator.spawnAgent(room.id, agentName, persona.id, selectedProvider, undefined, '', 'chat');
    this.syncSnapshot();
    if (!agent) {
      return `Unable to provision a ${persona.title} agent.`;
    }
    return `Provisioned ${agent.name} (${persona.title}, ${selectedProvider}) in room "${room.name}". They will pick up queued ${persona.title.toLowerCase()} work automatically.`;
  }

  createRoomFromChat(themeInput: string, nameInput: string, purpose?: string): string {
    const normalizedTheme = themeInput.trim().toLowerCase() as RoomTheme;
    const themeKeys = Object.keys(ROOM_THEME_META) as RoomTheme[];
    const theme = themeKeys.includes(normalizedTheme) ? normalizedTheme : themeKeys.find((candidate) => candidate.startsWith(normalizedTheme));
    if (!theme) {
      return `Unknown room theme "${themeInput}". Available themes: ${themeKeys.join(', ')}.`;
    }
    const meta = ROOM_THEME_META[theme];
    const name = nameInput.trim() || meta.label;
    const resolvedPurpose = purpose?.trim() || `Chat-provisioned ${meta.label.toLowerCase()} for related work.`;
    const room = this.coordinator.createRoom(name, theme, resolvedPurpose);
    this.syncSnapshot();
    return `Created room "${room.name}" (${theme}). Use \`/provision <persona> in ${room.name}\` to staff it.`;
  }

  renderStatusForChat(): string {
    const snapshot = this.coordinator.getSnapshot();
    const rooms = snapshot.rooms;
    const agents = snapshot.agents;
    const activeTasks = snapshot.tasks.filter((task) => task.status === 'active');
    const queuedTasks = snapshot.tasks.filter((task) => task.status === 'queued');
    const reviewTasks = snapshot.tasks.filter((task) => task.status === 'review');

    const lines: string[] = [];
    lines.push(`**Rooms (${rooms.length})**`);
    if (rooms.length === 0) {
      lines.push('- none yet. Run `/room general main` to create one.');
    } else {
      for (const room of rooms) {
        lines.push(`- ${room.name} · ${room.theme} · ${room.agentIds.length} agent(s)`);
      }
    }

    lines.push('');
    lines.push(`**Agents (${agents.length})**`);
    if (agents.length === 0) {
      lines.push('- none yet. Run `/provision lead` to staff the squad.');
    } else {
      for (const agent of agents) {
        const persona = snapshot.personas.find((entry) => entry.id === agent.personaId);
        lines.push(`- ${agent.name} · ${persona?.title ?? agent.personaId} · ${agent.provider} · ${agent.status}`);
      }
    }

    lines.push('');
    lines.push(`**Active lanes (${activeTasks.length})** · queued ${queuedTasks.length} · review ${reviewTasks.length}`);
    for (const task of activeTasks.slice(0, 5)) {
      lines.push(`- ${task.title} → ${this.coordinator.getSnapshot().agents.find((agent) => agent.id === task.assigneeId)?.name ?? task.assigneeId}`);
    }

    return lines.join('\n');
  }

  /**
   * Chat: /ask <agentOrPersona> <question>
   * Lets the developer talk to a specific teammate. Falls back to persona
   * routing if no agent matches by name.
   */
  async askAgentFromChat(target: string, question: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const normalizedTarget = target.trim().toLowerCase();
    const normalizedQuestion = question.trim();
    if (!normalizedTarget) {
      return 'Usage: `@pixel-squad /ask <agent or persona> <question>`. Example: `/ask Nova what is the plan for the login page?`.';
    }
    if (!normalizedQuestion) {
      return `Tell me what you want to ask ${target}. Usage: \`/ask ${target} <question>\`.`;
    }
    const snapshot = this.coordinator.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.name.toLowerCase() === normalizedTarget)
      ?? snapshot.agents.find((entry) => entry.name.toLowerCase().startsWith(normalizedTarget));
    if (agent) {
      const summary = await this.coordinator.assignTask(agent.id, normalizedQuestion, model, token);
      this.syncSnapshot();
      return `**Asked ${agent.name}**\n\n${summary}`;
    }
    const persona = snapshot.personas.find((entry) => entry.id.toLowerCase() === normalizedTarget)
      ?? snapshot.personas.find((entry) => entry.title.toLowerCase() === normalizedTarget);
    if (persona) {
      const summary = await this.coordinator.assignTaskToPersona(persona.id, normalizedQuestion, undefined, model, token, 'copilot-chat');
      this.syncSnapshot();
      return `**Asked the ${persona.title} lane**\n\n${summary}`;
    }
    return `No agent named "${target}" and no persona matching "${target}". Try \`/status\` to list current teammates.`;
  }

  /**
   * Chat: /team <theme> <task>
   * Rally every agent currently staffed in the theme room on the same task.
   */
  async teamFromChat(themeInput: string, prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const normalizedTheme = themeInput.trim().toLowerCase() as RoomTheme;
    const themeKeys = Object.keys(ROOM_THEME_META) as RoomTheme[];
    const theme = themeKeys.includes(normalizedTheme) ? normalizedTheme : themeKeys.find((candidate) => candidate.startsWith(normalizedTheme));
    const work = prompt.trim();
    if (!theme) {
      return `Unknown team theme "${themeInput}". Available: ${themeKeys.join(', ')}.`;
    }
    if (!work) {
      return `Tell the ${theme} team what to do. Usage: \`/team ${theme} <task>\`.`;
    }
    const snapshot = this.coordinator.getSnapshot();
    const rooms = snapshot.rooms.filter((room) => room.theme === theme);
    const agents = snapshot.agents.filter((agent) => rooms.some((room) => room.id === agent.roomId));
    if (agents.length === 0) {
      return `No agents staffed for the ${theme} team yet. Run \`/provision <persona>\` to staff the room first.`;
    }
    const summaries: string[] = [];
    for (const agent of agents) {
      const summary = await this.coordinator.assignTask(agent.id, work, model, token);
      summaries.push(`- ${agent.name}: ${summary}`);
    }
    this.syncSnapshot();
    return [`**Rallied ${agents.length} ${theme} teammate(s)**`, '', ...summaries].join('\n');
  }

  /**
   * Chat: /worklog [agent or team theme]
   * Compact rollup of what the squad has been doing.
   */
  renderWorkLogForChat(target: string): string {
    const snapshot = this.coordinator.getSnapshot();
    const normalized = target.trim().toLowerCase();
    const agents = snapshot.agents;
    const tasks = snapshot.tasks;
    const themeKeys = Object.keys(ROOM_THEME_META) as RoomTheme[];

    const describeAgent = (agentId: string, name: string) => {
      const agentTasks = tasks.filter((task) => task.assigneeId === agentId);
      const files = new Set<string>();
      let commandCount = 0;
      let completed = 0;
      for (const task of agentTasks) {
        for (const edit of task.executionPlan?.fileEdits ?? []) { files.add(edit.filePath); }
        commandCount += task.executionPlan?.terminalCommands.length ?? 0;
        if (task.status === 'done') { completed += 1; }
      }
      return `- **${name}**: ${completed}/${agentTasks.length} tasks done · ${files.size} files touched · ${commandCount} commands run.`;
    };

    if (!normalized) {
      if (agents.length === 0) { return 'No agents provisioned yet. Run `/provision lead` to staff your first teammate.'; }
      return ['**Squad work log**', '', ...agents.map((agent) => describeAgent(agent.id, agent.name))].join('\n');
    }

    const theme = themeKeys.includes(normalized as RoomTheme) ? (normalized as RoomTheme) : themeKeys.find((candidate) => candidate.startsWith(normalized));
    if (theme) {
      const teamAgents = agents.filter((agent) => snapshot.rooms.find((room) => room.id === agent.roomId)?.theme === theme);
      if (teamAgents.length === 0) { return `No agents staffed for the ${theme} team yet.`; }
      return [`**${theme} team work log**`, '', ...teamAgents.map((agent) => describeAgent(agent.id, agent.name))].join('\n');
    }

    const agent = agents.find((entry) => entry.name.toLowerCase() === normalized) ?? agents.find((entry) => entry.name.toLowerCase().startsWith(normalized));
    if (!agent) {
      return `No agent or team matched "${target}". Try \`/status\` to list current teammates.`;
    }
    return [`**${agent.name}'s work log**`, '', describeAgent(agent.id, agent.name)].join('\n');
  }

  renderMcpToolsForChat(): string {
    const external = discoverExternalTools();
    const lines: string[] = [];
    lines.push(`**MCP & extension tools available to Pixel Squad agents: ${external.length}**`);
    if (external.length === 0) {
      lines.push('');
      lines.push('No external tools are currently surfaced by VS Code. Install or start an MCP server so agents can use them during runs.');
    } else {
      for (const tool of external.slice(0, 20)) {
        lines.push(`- \`${tool.name}\` — ${tool.description ?? '(no description)'}`);
      }
      if (external.length > 20) {
        lines.push(`- …and ${external.length - 20} more.`);
      }
    }
    lines.push('');
    lines.push('Agents automatically pick the best tool for the job during execution.');
    return lines.join('\n');
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
    ])).slice(0, 2);
    const persona = snapshot.personas.find((item) => item.id === agent.personaId);
    const laneRef = focusTask?.id ?? run?.id ?? 'current lane';
    const goal = focusTask?.title ?? run?.title ?? `${agent.name}'s current runtime`;
    const latestSummary = !focusTask && latestAgentReply ? latestAgentReply.slice(0, 140) : undefined;

    return [
      `@pixel-squad /${agent.personaId} continue ${agent.name} on ${laneRef}.`,
      `Goal: ${goal}.`,
      fileTargets.length > 0 ? `Focus: ${fileTargets.join(', ')}.` : '',
      latestSummary ? `Context: ${latestSummary}` : '',
      persona ? `Stay in ${persona.title} lane. Update named files directly.` : 'Update named files directly.',
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
