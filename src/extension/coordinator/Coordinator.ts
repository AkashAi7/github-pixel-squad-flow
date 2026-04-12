import * as vscode from 'vscode';

import type { AgentStatus, PersonaTemplate, Provider, ProviderHealth, Room, RoomTheme, SquadAgent, TaskCard, TaskStatus, WorkspaceSnapshot } from '../../shared/model/index.js';
import { ROOM_THEME_META } from '../../shared/model/index.js';
import type { ActivityMessage, TaskOutputMessage } from '../../shared/protocol/messages.js';
import { EventBus } from './EventBus.js';
import { CopilotAdapter } from '../providers/copilot/CopilotAdapter.js';
import { ClaudeAdapter } from '../providers/claude/ClaudeAdapter.js';
import type { ProviderAdapter } from '../providers/types.js';
import { ProjectStateStore } from '../persistence/ProjectStateStore.js';

export class Coordinator {
  private readonly copilot = new CopilotAdapter();
  private readonly claude = new ClaudeAdapter();
  private readonly providers: Record<Provider, ProviderAdapter> = {
    copilot: this.copilot,
    claude: this.claude,
  };
  private readonly store: ProjectStateStore;
  private snapshot: WorkspaceSnapshot;
  readonly activityBus = new EventBus<ActivityMessage>();
  readonly taskOutputBus = new EventBus<TaskOutputMessage>();

  constructor(rootPath?: string) {
    this.store = new ProjectStateStore(rootPath);
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
    };
  }

  async createTask(prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken, provider?: Provider): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'Pixel Squad ignored an empty task request.';
    }

    const selectedProvider = provider ?? (this.getSettings().modelFamily as Provider) ?? 'copilot';
    const adapter = this.providers[selectedProvider] ?? this.copilot;
    const plan = await adapter.createPlan(normalizedPrompt, this.snapshot.personas, model, token);
    const updatedAgents = [...this.snapshot.agents];
    const newTasks: TaskCard[] = [];

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
      newTasks.push({
        id: this.makeId('task'),
        title: assignment.title,
        status: index === 0 ? 'active' : 'queued',
        assigneeId: refreshedAgent.id,
        provider: refreshedAgent.provider,
        source: 'factory',
        detail: assignment.detail,
      });
    }

    this.snapshot = {
      ...this.snapshot,
      agents: updatedAgents,
      tasks: [...newTasks, ...this.snapshot.tasks].slice(0, 40),
      providers: this.getProviderHealths(),
      activityFeed: [
        `Task received: ${plan.title}`,
        plan.providerDetail,
        ...this.snapshot.activityFeed,
      ].slice(0, 12),
      settings: this.getSettings(),
    };
    this.store.save(this.snapshot);

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
    };

    const updatedAgents = this.snapshot.agents.map((a) => a.id === agentId ? updatedAgent : a);
    const room = this.snapshot.rooms.find((r) => r.id === agent.roomId);

    this.snapshot = {
      ...this.snapshot,
      agents: updatedAgents,
      tasks: [task, ...this.snapshot.tasks].slice(0, 40),
      providers: this.getProviderHealths(),
      activityFeed: [
        `Task assigned to ${agent.name}: ${task.title}`,
        `${agent.name} started working in ${room?.name ?? 'unknown room'}`,
        ...this.snapshot.activityFeed,
      ].slice(0, 20),
      settings: this.getSettings(),
    };
    this.store.save(this.snapshot);

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

    const agent = this.snapshot.agents.find((a) => a.id === task.assigneeId);
    if (!agent) {
      return 'No agent assigned to this task.';
    }

    const persona = this.snapshot.personas.find((p) => p.id === agent.personaId);
    if (!persona) {
      return 'Agent persona not found.';
    }

    // Update task to active, agent to executing
    this.updateTask(taskId, { status: 'active' });
    this.updateAgent(agent.id, { status: 'executing', summary: `Executing: ${task.title}` });
    this.appendActivity(`${agent.name} started executing "${task.title}" via ${task.provider}.`);

    const adapter = this.providers[task.provider] ?? this.copilot;
    const result = await adapter.executeTask(task, agent, persona, model, token);

    if (result.success) {
      this.updateTask(taskId, { status: 'review', output: result.output });
      this.updateAgent(agent.id, { status: 'waiting', summary: `Completed: ${task.title} — awaiting review.` });
      this.appendActivity(`${agent.name} finished "${task.title}" — moved to review.`);
    } else {
      this.updateTask(taskId, { status: 'failed', output: result.output });
      this.updateAgent(agent.id, { status: 'failed', summary: `Failed: ${task.title}` });
      this.appendActivity(`${agent.name} failed on "${task.title}".`);
    }

    this.taskOutputBus.publish({ type: 'taskOutput', taskId, output: result.output });
    this.store.save(this.snapshot);
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

  taskAction(taskId: string, action: 'execute' | 'complete' | 'fail' | 'retry'): void {
    const task = this.snapshot.tasks.find((t) => t.id === taskId);
    if (!task) {
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

    if (!newStatus) {
      this.appendActivity(`Cannot ${action} task "${task.title}" (currently ${task.status}).`);
      return;
    }

    const updates: Partial<TaskCard> = { status: newStatus };
    if (action === 'retry') {
      updates.output = undefined;
    }
    if (action === 'complete') {
      // Move assigned agent to idle
      const agent = this.snapshot.agents.find((a) => a.id === task.assigneeId);
      if (agent) {
        this.updateAgent(agent.id, { status: 'idle', summary: `Completed: ${task.title}` });
      }
    }

    this.updateTask(taskId, updates);
    this.appendActivity(`Task "${task.title}": ${action} → ${newStatus}.`);
    this.store.save(this.snapshot);
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
    this.appendActivity(`Room "${room.name}" created.`);
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
    this.appendActivity(`Room "${room.name}" deleted (${orphanedAgentIds.size} agents removed).`);
    this.store.save(this.snapshot);
  }

  /* ── Agent spawning ───────────────────────────────── */

  spawnAgent(roomId: string, name: string, personaId: string, provider: Provider): SquadAgent | undefined {
    const room = this.snapshot.rooms.find((r) => r.id === roomId);
    if (!room) return undefined;

    const persona = this.snapshot.personas.find((p) => p.id === personaId);
    if (!persona) return undefined;

    const agent: SquadAgent = {
      id: this.makeId('agent'),
      name: name.trim() || `${persona.title}-${room.agentIds.length + 1}`,
      personaId,
      provider,
      status: 'idle',
      roomId,
      summary: `Ready for ${persona.specialty.toLowerCase()} tasks.`,
      spriteVariant: Math.floor(Math.random() * 4),
    };

    this.snapshot = {
      ...this.snapshot,
      agents: [...this.snapshot.agents, agent],
      rooms: this.snapshot.rooms.map((r) =>
        r.id === roomId ? { ...r, agentIds: [...r.agentIds, agent.id] } : r,
      ),
    };
    this.appendActivity(`Agent "${agent.name}" spawned in "${room.name}" (${provider}).`);
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
        t.assigneeId === agentId ? { ...t, status: 'failed' as TaskStatus } : t,
      ),
    };
    this.appendActivity(`Agent "${agent.name}" removed.`);
    this.store.save(this.snapshot);
  }

  resetWorkspace(): void {
    this.snapshot = this.loadSnapshot();
    this.store.save(this.snapshot);
  }

  notifyWebviewConnected(): void {
    this.appendActivity('Factory panel connected to coordinator.');
  }

  selectAgent(agentId: string): void {
    this.appendActivity(`Inspector focused on ${agentId}.`);
  }

  private updateTask(taskId: string, updates: Partial<TaskCard>): void {
    this.snapshot = {
      ...this.snapshot,
      tasks: this.snapshot.tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates } : t
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

  private appendActivity(message: string): void {
    this.snapshot = {
      ...this.snapshot,
      providers: this.getProviderHealths(),
      activityFeed: [message, ...this.snapshot.activityFeed].slice(0, 20),
    };
    this.store.save(this.snapshot);
    this.activityBus.publish({ type: 'activity', message });
  }

  private makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }
}
