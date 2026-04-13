import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec, type ExecException } from 'node:child_process';
import * as vscode from 'vscode';

import type { ActivityCategory, ActivityEntry, AgentStatus, CommandExecutionResult, CustomPersonaDraft, HandoffPacket, PersonaTemplate, Provider, ProviderHealth, Room, RoomTheme, SquadAgent, TaskCard, TaskExecutionPlan, TaskProgress, TaskStatus, WorkspaceSnapshot } from '../../shared/model/index.js';
import { ROOM_THEME_META, createActivityEntry, levelFromXp } from '../../shared/model/index.js';
import type { ActivityMessage, TaskOutputMessage } from '../../shared/protocol/messages.js';
import { EventBus } from './EventBus.js';
import { TaskScheduler } from './TaskScheduler.js';
import { CopilotAdapter } from '../providers/copilot/CopilotAdapter.js';
import { ClaudeAdapter } from '../providers/claude/ClaudeAdapter.js';
import type { ProviderAdapter } from '../providers/types.js';
import { ProjectStateStore } from '../persistence/ProjectStateStore.js';
import { WorkspaceContextService } from '../workspace/WorkspaceContextService.js';

export class Coordinator {
  private readonly copilot = new CopilotAdapter();
  private readonly claude = new ClaudeAdapter();
  private readonly providers: Record<Provider, ProviderAdapter> = {
    copilot: this.copilot,
    claude: this.claude,
  };
  private readonly rootPath: string | undefined;
  private readonly store: ProjectStateStore;
  private readonly workspaceContext: WorkspaceContextService;
  private readonly scheduler = new TaskScheduler(3);
  private snapshot: WorkspaceSnapshot;
  readonly activityBus = new EventBus<ActivityMessage>();
  readonly taskOutputBus = new EventBus<TaskOutputMessage>();

  constructor(rootPath?: string) {
    this.rootPath = rootPath;
    this.store = new ProjectStateStore(rootPath);
    this.workspaceContext = new WorkspaceContextService(rootPath);
    this.snapshot = this.loadSnapshot();
  }

  getSnapshot(): WorkspaceSnapshot {
    return this.snapshot;
  }

  getSettings() {
    const config = vscode.workspace.getConfiguration('pixelSquad');
    return {
      autoExecute: config.get<boolean>('autoExecute', false),
      modelFamily: config.get<string>('modelFamily', 'copilot'),
      autoPopulateWorkspaceContext: config.get<boolean>('autoPopulateWorkspaceContext', true),
      workspaceContextMaxFiles: config.get<number>('workspaceContextMaxFiles', 6),
    };
  }

  async createTask(prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken, provider?: Provider): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'Pixel Squad ignored an empty task request.';
    }

    const settings = this.getSettings();
    const workspaceContext = settings.autoPopulateWorkspaceContext
      ? await this.workspaceContext.capture(normalizedPrompt, settings.workspaceContextMaxFiles)
      : { relevantFiles: [] };
    const selectedProvider = provider ?? (this.getSettings().modelFamily as Provider) ?? 'copilot';
    const adapter = this.providers[selectedProvider] ?? this.copilot;
    const plan = await adapter.createPlan(normalizedPrompt, this.snapshot.personas, workspaceContext, model, token);
    const updatedAgents = [...this.snapshot.agents];
    const newTasks: TaskCard[] = [];
    const createdAt = Date.now();
    const stagedTaskIds = plan.assignments.map(() => this.makeId('task'));
    const personaTaskMap = new Map<string, string>();

    for (const [index, assignment] of plan.assignments.entries()) {
      const agent = updatedAgents.find((item) => item.personaId === assignment.personaId)
        ?? updatedAgents.find((item) => item.personaId === 'lead');
      if (!agent) {
        continue;
      }

      const refreshedAgent: SquadAgent = {
        ...agent,
        status: index === 0 ? 'executing' : 'planning',
        summary: assignment.detail,
      };
      updatedAgents[updatedAgents.findIndex((item) => item.id === agent.id)] = refreshedAgent;
      const dependencyIds = assignment.dependsOnPersonaIds
        ?.map((personaId) => personaTaskMap.get(personaId))
        .filter((taskId): taskId is string => Boolean(taskId))
        ?? [];
      const inferredDependencyIds = dependencyIds.length > 0
        ? dependencyIds
        : index > 0
          ? [stagedTaskIds[index - 1]]
          : [];

      newTasks.push({
        id: stagedTaskIds[index],
        title: assignment.title,
        status: index === 0 ? 'active' : 'queued',
        assigneeId: refreshedAgent.id,
        provider: refreshedAgent.provider,
        source: 'factory',
        detail: assignment.detail,
        dependsOn: inferredDependencyIds,
        requiredSkillIds: assignment.requiredSkillIds ?? [],
        workspaceContext,
        progress: this.progressForStatus(index === 0 ? 'active' : 'queued', assignment.progressLabel),
        createdAt,
        updatedAt: createdAt,
      });
      personaTaskMap.set(assignment.personaId, stagedTaskIds[index]);
    }

    this.snapshot = {
      ...this.snapshot,
      agents: updatedAgents,
      tasks: [...newTasks, ...this.snapshot.tasks].slice(0, 40),
      providers: this.getProviderHealths(),
      settings: this.getSettings(),
    };
    this.store.save(this.snapshot);
    this.appendActivity(`Task received: ${plan.title}`, { category: 'task', provider: selectedProvider });
    this.appendActivity(plan.providerDetail, { category: 'provider', provider: selectedProvider });

    // Auto-execute first active task if enabled
    if (this.getSettings().autoExecute && newTasks.length > 0) {
      const firstActive = newTasks.find((t) => t.status === 'active');
      if (firstActive) {
        void this.executeTask(firstActive.id);
      }
    }

    return `${plan.summary} ${plan.providerDetail}`;
  }

  async assignTask(agentId: string, prompt: string): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'Pixel Squad ignored an empty task.';
    }

    const settings = this.getSettings();
    const workspaceContext = settings.autoPopulateWorkspaceContext
      ? await this.workspaceContext.capture(normalizedPrompt, settings.workspaceContextMaxFiles)
      : { relevantFiles: [] };

    const agent = this.snapshot.agents.find((a) => a.id === agentId);
    if (!agent) {
      return 'Agent not found.';
    }

    const updatedAgent: SquadAgent = {
      ...agent,
      status: 'executing' as AgentStatus,
      summary: normalizedPrompt,
    };

    const task: TaskCard = {
      id: this.makeId('task'),
      title: normalizedPrompt.length > 60 ? normalizedPrompt.slice(0, 57) + '...' : normalizedPrompt,
      status: 'active',
      assigneeId: agent.id,
      provider: agent.provider,
      source: 'factory',
      detail: normalizedPrompt,
      dependsOn: [],
      requiredSkillIds: [],
      workspaceContext,
      progress: this.progressForStatus('active'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const updatedAgents = this.snapshot.agents.map((a) => a.id === agentId ? updatedAgent : a);
    const room = this.snapshot.rooms.find((r) => r.id === agent.roomId);

    this.snapshot = {
      ...this.snapshot,
      agents: updatedAgents,
      tasks: [task, ...this.snapshot.tasks].slice(0, 40),
      providers: this.getProviderHealths(),
      settings: this.getSettings(),
    };
    this.store.save(this.snapshot);
    this.appendActivity(`Task assigned to ${agent.name}: ${task.title}`, {
      category: 'task',
      taskId: task.id,
      agentId: agent.id,
      roomId: room?.id,
      provider: agent.provider,
    });
    this.appendActivity(`${agent.name} started working in ${room?.name ?? 'unknown room'}`, {
      category: 'agent',
      agentId: agent.id,
      roomId: room?.id,
      provider: agent.provider,
    });

    // Auto-execute
    if (this.getSettings().autoExecute) {
      void this.executeTask(task.id);
    }

    return `Task assigned to ${agent.name} (${agent.provider}).`;
  }

  async executeTask(taskId: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const task = this.snapshot.tasks.find((t) => t.id === taskId);
    if (!task) {
      return 'Task not found.';
    }

    const blockedDependencies = this.getBlockedDependencies(task);
    if (blockedDependencies.length > 0) {
      const dependencyNames = blockedDependencies.map((dependency) => dependency.title).join(', ');
      this.appendActivity(`Task "${task.title}" is blocked by: ${dependencyNames}.`, {
        category: 'task',
        taskId: task.id,
        provider: task.provider,
      });
      return `Task is blocked until these dependencies complete: ${dependencyNames}.`;
    }

    // Scheduler guard: prevent double-starts and enforce concurrency cap
    if (!this.scheduler.canStart(taskId)) {
      const reason = this.scheduler.isRunning(taskId) ? 'already running' : 'concurrency limit reached';
      this.appendActivity(`Task "${task.title}" skipped (${reason}).`, {
        category: 'task',
        taskId: task.id,
        provider: task.provider,
      });
      return `Task skipped: ${reason}.`;
    }
    this.scheduler.start(taskId);

    const agent = this.snapshot.agents.find((a) => a.id === task.assigneeId);
    if (!agent) {
      this.scheduler.finish(taskId);
      return 'No agent assigned to this task.';
    }

    const persona = this.snapshot.personas.find((p) => p.id === agent.personaId);
    if (!persona) {
      this.scheduler.finish(taskId);
      return 'Agent persona not found.';
    }

    const workspaceContext = task.workspaceContext ?? await this.workspaceContext.capture(`${task.title}\n${task.detail}`);
    const room = this.snapshot.rooms.find((r) => r.id === agent.roomId);

    // Collect handoff packets from completed predecessor tasks
    const handoffPackets = this.collectHandoffPackets(task);

    // Update task to active, agent to executing
    this.updateTask(taskId, {
      status: 'active',
      progress: this.progressForStatus('active'),
      workspaceContext,
      approvalState: undefined,
      handoffPackets: handoffPackets.length > 0 ? handoffPackets : undefined,
    });
    this.updateAgent(agent.id, { status: 'executing', summary: `Executing: ${task.title}` });
    this.appendActivity(`${agent.name} started executing "${task.title}" via ${task.provider}${handoffPackets.length > 0 ? ` (with ${handoffPackets.length} handoff packet(s))` : ''}.`, {
      category: 'task',
      taskId,
      agentId: agent.id,
      provider: task.provider,
    });

    const adapter = this.providers[task.provider] ?? this.copilot;
    const executionTask = this.snapshot.tasks.find((candidate) => candidate.id === taskId) ?? { ...task, workspaceContext };
    const result = await adapter.executeTask(executionTask, agent, persona, workspaceContext, model, token, room, handoffPackets);
    const hydratedPlan = this.hydrateExecutionPlan(result.plan);

    if (result.success) {
      const newXp = (agent.xp ?? 0) + 25;
      const newLevel = levelFromXp(newXp);
      const leveledUp = newLevel > (agent.level ?? 0);
      this.updateTask(taskId, {
        status: 'review',
        output: result.output,
        executionPlan: hydratedPlan,
        approvalState: hydratedPlan && (hydratedPlan.fileEdits.length > 0 || hydratedPlan.terminalCommands.length > 0) ? 'pending' : undefined,
        progress: this.progressForStatus('review'),
      });
      this.updateAgent(agent.id, { status: 'waiting', summary: `Completed: ${task.title} — awaiting review.`, xp: newXp, level: newLevel });
      this.appendActivity(`${agent.name} finished "${task.title}" — moved to review.`, {
        category: 'task',
        taskId,
        agentId: agent.id,
        provider: task.provider,
      });
      if (leveledUp) {
        this.appendActivity(`🌟 ${agent.name} leveled up to Lv.${newLevel}!`, {
          category: 'agent',
          agentId: agent.id,
          provider: agent.provider,
        });
      }
    } else {
      this.updateTask(taskId, { status: 'failed', output: result.output, progress: this.progressForStatus('failed') });
      this.updateAgent(agent.id, { status: 'failed', summary: `Failed: ${task.title}` });
      this.appendActivity(`${agent.name} failed on "${task.title}".`, {
        category: 'task',
        taskId,
        agentId: agent.id,
        provider: task.provider,
      });
    }

    this.scheduler.finish(taskId);
    this.taskOutputBus.publish({ type: 'taskOutput', taskId, output: result.output });
    this.store.save(this.snapshot);

    // Auto-promote downstream tasks whose dependencies are now met
    this.promoteReadyTasks();

    return result.output;
  }

  agentAction(agentId: string, action: 'pause' | 'resume' | 'complete' | 'retry'): void {
    const agent = this.snapshot.agents.find((a) => a.id === agentId);
    if (!agent) {
      return;
    }

    const transitions: Record<string, Partial<Record<AgentStatus, AgentStatus>>> = {
      pause: { executing: 'paused', planning: 'paused' },
      resume: { paused: 'executing', blocked: 'executing', failed: 'executing' },
      complete: { executing: 'completed', waiting: 'completed', paused: 'completed' },
      retry: { failed: 'executing', blocked: 'executing' },
    };

    const newStatus = transitions[action]?.[agent.status];
    if (!newStatus) {
      this.appendActivity(`Cannot ${action} agent ${agent.name} (currently ${agent.status}).`);
      return;
    }

    this.updateAgent(agentId, { status: newStatus });
    this.appendActivity(`${agent.name}: ${action} → ${newStatus}.`);
    this.store.save(this.snapshot);
  }

  async taskAction(taskId: string, action: 'execute' | 'complete' | 'fail' | 'retry' | 'run'): Promise<void> {
    const task = this.snapshot.tasks.find((t) => t.id === taskId);
    if (!task) {
      return;
    }

    if (action === 'run') {
      await this.runTaskCommands(task);
      return;
    }

    const transitions: Record<string, Partial<Record<TaskStatus, TaskStatus>>> = {
      execute: { queued: 'active' },
      complete: { review: 'done', active: 'done' },
      fail: { active: 'failed', review: 'failed' },
      retry: { failed: 'queued', done: 'queued' },
    };

    const newStatus = transitions[action]?.[task.status];

    if (action === 'execute' && (task.status === 'queued' || task.status === 'active')) {
      void this.executeTask(taskId);
      return;
    }

    if (action === 'complete' && task.status === 'review') {
      const applied = await this.applyTaskPlan(task);
      if (!applied) {
        return;
      }
    }

    if (!newStatus) {
      this.appendActivity(`Cannot ${action} task "${task.title}" (currently ${task.status}).`, {
        category: 'task',
        taskId,
        provider: task.provider,
      });
      return;
    }

    const updates: Partial<TaskCard> = { status: newStatus, progress: this.progressForStatus(newStatus) };
    if (action === 'retry') {
      updates.output = undefined;
      updates.executionPlan = undefined;
      updates.approvalState = 'rejected';
    }
    if (action === 'complete') {
      // Move assigned agent to idle and award XP
      const agent = this.snapshot.agents.find((a) => a.id === task.assigneeId);
      if (agent) {
        const newXp = (agent.xp ?? 0) + 25;
        const newLevel = levelFromXp(newXp);
        const leveledUp = newLevel > (agent.level ?? 0);
        this.updateAgent(agent.id, { status: 'idle', summary: `Completed: ${task.title}`, xp: newXp, level: newLevel });
        if (leveledUp) {
          this.appendActivity(`🌟 ${agent.name} leveled up to Lv.${newLevel}!`, {
            category: 'agent',
            agentId: agent.id,
            provider: agent.provider,
          });
        }
      }
      updates.approvalState = task.executionPlan && (task.executionPlan.fileEdits.length > 0 || task.executionPlan.terminalCommands.length > 0)
        ? 'applied'
        : task.approvalState;
    }

    this.updateTask(taskId, updates);
    this.appendActivity(`Task "${task.title}": ${action} → ${newStatus}.`, {
      category: 'task',
      taskId,
      provider: task.provider,
    });
    this.store.save(this.snapshot);

    // When a task completes, check if downstream tasks are now unblocked
    if (action === 'complete') {
      this.promoteReadyTasks();
    }
  }

  /* ── Room CRUD ──────────────────────────────────────── */

  createRoom(name: string, theme: RoomTheme, purpose: string): Room {
    const meta = ROOM_THEME_META[theme];
    const room: Room = {
      id: this.makeId('room'),
      name: name.trim() || meta.label,
      theme,
      purpose: purpose.trim() || `A ${meta.label.toLowerCase()} for your squad.`,
      color: meta.color,
      agentIds: [],
    };
    this.snapshot = {
      ...this.snapshot,
      rooms: [...this.snapshot.rooms, room],
    };
    this.appendActivity(`Room "${room.name}" created.`, { category: 'system', roomId: room.id });
    this.store.save(this.snapshot);
    return room;
  }

  deleteRoom(roomId: string): void {
    const room = this.snapshot.rooms.find((r) => r.id === roomId);
    if (!room) return;

    // Unassign agents in the room
    const orphanedAgentIds = new Set(room.agentIds);
    this.snapshot = {
      ...this.snapshot,
      rooms: this.snapshot.rooms.filter((r) => r.id !== roomId),
      agents: this.snapshot.agents.filter((a) => !orphanedAgentIds.has(a.id)),
    };
    this.appendActivity(`Room "${room.name}" deleted (${orphanedAgentIds.size} agents removed).`, { category: 'system', roomId });
    this.store.save(this.snapshot);
  }

  /* ── Agent spawning ───────────────────────────────── */

  spawnAgent(roomId: string, name: string, personaId: string, provider: Provider, customPersona?: CustomPersonaDraft): SquadAgent | undefined {
    const room = this.snapshot.rooms.find((r) => r.id === roomId);
    if (!room) return undefined;

    const nextPersona = customPersona ? this.ensureCustomPersona(customPersona) : undefined;
    const resolvedPersonaId = nextPersona?.id ?? personaId;
    const persona = this.snapshot.personas.find((p) => p.id === resolvedPersonaId) ?? nextPersona;
    if (!persona) return undefined;

    const agent: SquadAgent = {
      id: this.makeId('agent'),
      name: name.trim() || `${persona.title}-${room.agentIds.length + 1}`,
      personaId: resolvedPersonaId,
      provider,
      status: 'idle',
      roomId,
      summary: `Ready for ${persona.specialty.toLowerCase()} tasks.`,
      spriteVariant: Math.floor(Math.random() * 4),
      xp: 0,
      level: 0,
    };

    this.snapshot = {
      ...this.snapshot,
      personas: nextPersona ? [...this.snapshot.personas.filter((entry) => entry.id !== nextPersona.id), nextPersona] : this.snapshot.personas,
      agents: [...this.snapshot.agents, agent],
      rooms: this.snapshot.rooms.map((r) =>
        r.id === roomId ? { ...r, agentIds: [...r.agentIds, agent.id] } : r,
      ),
    };
    this.appendActivity(`Agent "${agent.name}" spawned in "${room.name}" (${provider}).`, {
      category: 'agent',
      agentId: agent.id,
      roomId,
      provider,
    });
    this.store.save(this.snapshot);
    return agent;
  }

  removeAgent(agentId: string): void {
    const agent = this.snapshot.agents.find((a) => a.id === agentId);
    if (!agent) return;

    this.snapshot = {
      ...this.snapshot,
      agents: this.snapshot.agents.filter((a) => a.id !== agentId),
      rooms: this.snapshot.rooms.map((r) =>
        r.id === agent.roomId ? { ...r, agentIds: r.agentIds.filter((id) => id !== agentId) } : r,
      ),
      tasks: this.snapshot.tasks.map((t) =>
        t.assigneeId === agentId ? { ...t, status: 'failed' as TaskStatus, progress: this.progressForStatus('failed') } : t,
      ),
    };
    this.appendActivity(`Agent "${agent.name}" removed.`, { category: 'agent', agentId, roomId: agent.roomId, provider: agent.provider });
    this.store.save(this.snapshot);
  }

  resetWorkspace(): void {
    const snapshot = this.store.reset();
    this.snapshot = {
      ...snapshot,
      providers: this.getProviderHealths(),
      settings: this.getSettings(),
    };
    this.store.save(this.snapshot);
  }

  notifyWebviewConnected(): void {
    this.appendActivity('Factory panel connected to coordinator.', { category: 'system' });
  }

  selectAgent(agentId: string): void {
    this.appendActivity(`Inspector focused on ${agentId}.`, { category: 'agent', agentId });
  }

  private updateTask(taskId: string, updates: Partial<TaskCard>): void {
    this.snapshot = {
      ...this.snapshot,
      tasks: this.snapshot.tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
      ),
    };
  }

  private updateAgent(agentId: string, updates: Partial<SquadAgent>): void {
    this.snapshot = {
      ...this.snapshot,
      agents: this.snapshot.agents.map((a) =>
        a.id === agentId ? { ...a, ...updates } : a
      ),
    };
  }

  private loadSnapshot(): WorkspaceSnapshot {
    const snapshot = this.store.load();
    return {
      ...snapshot,
      providers: this.getProviderHealths(),
      settings: snapshot.settings ?? this.getSettings(),
    };
  }

  private getProviderHealths(): ProviderHealth[] {
    return [this.copilot.getHealth(), this.claude.getHealth()];
  }

  private appendActivity(
    message: string,
    metadata: Partial<Omit<ActivityEntry, 'id' | 'message' | 'timestamp' | 'category'>> & { category?: ActivityCategory } = {},
  ): void {
    const activity = createActivityEntry(message, metadata.category ?? 'system', metadata);
    this.snapshot = {
      ...this.snapshot,
      providers: this.getProviderHealths(),
      activityFeed: [activity, ...this.snapshot.activityFeed].slice(0, 20),
    };
    this.store.save(this.snapshot);
    this.activityBus.publish({ type: 'activity', message, activity });
  }

  private getBlockedDependencies(task: TaskCard): TaskCard[] {
    const dependencyIds = task.dependsOn ?? [];
    if (dependencyIds.length === 0) {
      return [];
    }

    return dependencyIds
      .map((dependencyId) => this.snapshot.tasks.find((candidate) => candidate.id === dependencyId))
      .filter((dependency): dependency is TaskCard => dependency !== undefined)
      .filter((dependency) => dependency.status !== 'done');
  }

  private progressForStatus(status: TaskStatus, label?: string): TaskProgress {
    switch (status) {
      case 'queued':
        return { value: 0, total: 3, label: label ?? 'Queued' };
      case 'active':
        return { value: 1, total: 3, label: label ?? 'Executing' };
      case 'review':
        return { value: 2, total: 3, label: label ?? 'Review' };
      case 'done':
        return { value: 3, total: 3, label: label ?? 'Complete' };
      case 'failed':
        return { value: 3, total: 3, label: label ?? 'Failed' };
    }
  }

  private makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  private ensureCustomPersona(draft: CustomPersonaDraft): PersonaTemplate {
    const normalizedTitle = draft.title.trim() || 'Custom Agent';
    const existing = this.snapshot.personas.find((persona) => persona.isCustom && persona.title.toLowerCase() === normalizedTitle.toLowerCase());
    const personaId = existing?.id ?? `custom-${normalizedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.floor(Math.random() * 1000)}`;

    return {
      id: personaId,
      title: normalizedTitle,
      specialty: draft.specialty.trim() || 'Custom workflow specialist',
      color: draft.color,
      skills: (draft.skills ?? []).filter((skill) => skill.label.trim().length > 0).map((skill, index) => ({
        id: skill.id || `custom-skill-${index + 1}`,
        label: skill.label.trim(),
        level: Math.max(1, Math.min(5, skill.level)),
      })),
      isCustom: true,
    };
  }

  private hydrateExecutionPlan(plan: TaskExecutionPlan | undefined): TaskExecutionPlan | undefined {
    if (!plan) {
      return undefined;
    }

    return {
      ...plan,
      commandResults: plan.commandResults ?? [],
      fileEdits: plan.fileEdits.map((fileEdit) => ({
        ...fileEdit,
        originalContent: fileEdit.originalContent ?? this.readWorkspaceFile(fileEdit.filePath),
      })),
    };
  }

  private readWorkspaceFile(filePath: string): string | undefined {
    if (!this.rootPath) {
      return undefined;
    }

    const workspaceRoot = path.resolve(this.rootPath);
    const targetPath = path.resolve(this.rootPath, filePath);
    if (!targetPath.startsWith(workspaceRoot) || !fs.existsSync(targetPath)) {
      return undefined;
    }

    try {
      return fs.readFileSync(targetPath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private async applyTaskPlan(task: TaskCard): Promise<boolean> {
    const plan = task.executionPlan;
    if (!plan || plan.fileEdits.length === 0) {
      return true;
    }
    if (!this.rootPath) {
      this.appendActivity(`Task "${task.title}" could not apply changes because no workspace root is available.`, {
        category: 'task',
        taskId: task.id,
        provider: task.provider,
      });
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const proposedEdit of plan.fileEdits) {
      const targetPath = path.resolve(this.rootPath, proposedEdit.filePath);
      if (!targetPath.startsWith(path.resolve(this.rootPath))) {
        this.appendActivity(`Skipped unsafe file path outside workspace: ${proposedEdit.filePath}.`, {
          category: 'task',
          taskId: task.id,
          provider: task.provider,
        });
        continue;
      }

      const targetUri = vscode.Uri.file(targetPath);
      const encoded = Buffer.from(proposedEdit.content, 'utf8');
      if (proposedEdit.action === 'create') {
        edit.createFile(targetUri, { ignoreIfExists: false, overwrite: true });
      }
      edit.replace(targetUri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), proposedEdit.content);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetPath)));
      await vscode.workspace.fs.writeFile(targetUri, encoded);
    }

    this.appendActivity(`Applied ${plan.fileEdits.length} file change(s) for "${task.title}".`, {
      category: 'task',
      taskId: task.id,
      provider: task.provider,
    });
    return true;
  }

  /**
   * Build handoff packets from completed dependency tasks so the downstream
   * task has full context of what predecessors accomplished.
   */
  private collectHandoffPackets(task: TaskCard): HandoffPacket[] {
    const dependencyIds = task.dependsOn ?? [];
    if (dependencyIds.length === 0) {
      return [];
    }

    return dependencyIds
      .map((depId) => this.snapshot.tasks.find((t) => t.id === depId))
      .filter((dep): dep is TaskCard => dep !== undefined && dep.status === 'done')
      .map((dep) => {
        const depAgent = this.snapshot.agents.find((a) => a.id === dep.assigneeId);
        return {
          fromTaskId: dep.id,
          fromAgentName: depAgent?.name ?? 'unknown',
          summary: dep.executionPlan?.summary ?? dep.detail,
          filesChanged: dep.executionPlan?.fileEdits.map((e) => e.filePath) ?? [],
          commandsRun: dep.executionPlan?.terminalCommands.map((c) => c.command) ?? [],
          testsRun: dep.executionPlan?.tests ?? [],
          openIssues: dep.executionPlan?.notes ?? [],
          output: dep.output ?? '',
        } satisfies HandoffPacket;
      });
  }

  /**
   * Scan queued tasks and auto-execute any whose dependencies are now all done.
   * Respects the scheduler concurrency cap.
   */
  private promoteReadyTasks(): void {
    if (!this.getSettings().autoExecute) {
      return;
    }

    const queuedTasks = this.snapshot.tasks.filter((t) => t.status === 'queued');
    for (const task of queuedTasks) {
      if (!this.scheduler.hasCapacity) {
        break;
      }

      const blocked = this.getBlockedDependencies(task);
      if (blocked.length === 0) {
        this.appendActivity(`Auto-promoting "${task.title}" — all dependencies met.`, {
          category: 'task',
          taskId: task.id,
          provider: task.provider,
        });
        void this.executeTask(task.id);
      }
    }
  }

  private async runTaskCommands(task: TaskCard): Promise<void> {
    const commands = task.executionPlan?.terminalCommands ?? [];
    if (commands.length === 0) {
      this.appendActivity(`Task "${task.title}" has no terminal commands to run.`, {
        category: 'task',
        taskId: task.id,
        provider: task.provider,
      });
      return;
    }

    const plan = task.executionPlan;
    if (!plan || !this.rootPath) {
      this.appendActivity(`Task "${task.title}" cannot run commands because no workspace root is available.`, {
        category: 'task',
        taskId: task.id,
        provider: task.provider,
      });
      return;
    }

    let results: CommandExecutionResult[] = commands.map((command, index) => ({
      commandIndex: index,
      command: command.command,
      summary: command.summary,
      status: 'pending',
    }));
    this.updateTask(task.id, {
      executionPlan: {
        ...plan,
        commandResults: results,
      },
    });
    this.appendActivity(`Running ${commands.length} captured command(s) for "${task.title}".`, {
      category: 'task',
      taskId: task.id,
      provider: task.provider,
    });

    for (const [index, command] of commands.entries()) {
      const startedAt = Date.now();
      results = results.map((result) => result.commandIndex === index
        ? {
            ...result,
            status: 'running',
            startedAt,
          }
        : result);
      this.updateTask(task.id, {
        executionPlan: {
          ...plan,
          commandResults: results,
        },
      });
      this.store.save(this.snapshot);

      try {
        const output = await this.execWorkspaceCommand(command.command);
        const completedAt = Date.now();
        results = results.map((result) => result.commandIndex === index
          ? {
              ...result,
              status: 'succeeded',
              exitCode: 0,
              stdout: this.truncateCommandOutput(output.stdout),
              stderr: this.truncateCommandOutput(output.stderr),
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
            }
          : result);
        this.appendActivity(`Command succeeded for "${task.title}": ${command.command}`, {
          category: 'task',
          taskId: task.id,
          provider: task.provider,
        });
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string | null };
        const completedAt = Date.now();
        const exitCode = typeof failure.code === 'number' ? failure.code : 1;
        results = results.map((result) => result.commandIndex === index
          ? {
              ...result,
              status: 'failed',
              exitCode,
              stdout: this.truncateCommandOutput(failure.stdout),
              stderr: this.truncateCommandOutput(failure.stderr || failure.message),
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
            }
          : result);
        this.appendActivity(`Command failed for "${task.title}" (exit ${exitCode}): ${command.command}`, {
          category: 'task',
          taskId: task.id,
          provider: task.provider,
        });
        this.updateTask(task.id, {
          executionPlan: {
            ...plan,
            commandResults: results,
          },
        });
        this.store.save(this.snapshot);
        return;
      }

      this.updateTask(task.id, {
        executionPlan: {
          ...plan,
          commandResults: results,
        },
      });
    }

    this.appendActivity(`Captured ${commands.length} command result(s) for "${task.title}".`, {
      category: 'task',
      taskId: task.id,
      provider: task.provider,
    });
    this.store.save(this.snapshot);
  }

  private execWorkspaceCommand(command: string): Promise<{ stdout: string; stderr: string }> {
    const shellPath = process.platform === 'win32'
      ? (process.env.ComSpec ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/sh');

    return new Promise((resolve, reject) => {
      exec(command, {
        cwd: this.rootPath,
        maxBuffer: 1024 * 1024,
        shell: shellPath,
        windowsHide: true,
      }, (error: ExecException | null, stdout: string, stderr: string) => {
        if (error) {
          const enriched = error as Error & { stdout?: string; stderr?: string; code?: number | string | null };
          enriched.stdout = stdout;
          enriched.stderr = stderr;
          reject(enriched);
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  }

  private truncateCommandOutput(output: string | undefined, maxLength = 12000): string | undefined {
    if (!output) {
      return undefined;
    }

    const normalized = output.trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength)}\n... output truncated ...`;
  }
}
