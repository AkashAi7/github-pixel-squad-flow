import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec, type ExecException } from 'node:child_process';
import * as vscode from 'vscode';

import type { ActivityCategory, ActivityEntry, AgentMessage, AgentSession, AgentSessionMessage, AgentSessionMessageRole, AgentSessionStatus, AgentStatus, CommandExecutionResult, CustomPersonaDraft, HandoffPacket, PersonaTemplate, Provider, ProviderHealth, Room, RoomTheme, RunRecord, RunStatus, RunStage, SquadAgent, TaskCard, TaskExecutionPlan, TaskProgress, TaskSource, TaskStatus, ToolPreference, ToolPreferenceReason, WorkspaceSnapshot } from '../../shared/model/index.js';
import { ROOM_THEME_META, createActivityEntry } from '../../shared/model/index.js';
import type { ActivityMessage, AgentChatMessage, TaskOutputMessage, TaskStreamChunkMessage } from '../../shared/protocol/messages.js';
import { EventBus } from './EventBus.js';
import { TaskScheduler } from './TaskScheduler.js';
import { AgentMailbox } from './AgentMailbox.js';
import { CopilotAdapter } from '../providers/copilot/CopilotAdapter.js';
import { ClaudeAdapter } from '../providers/claude/ClaudeAdapter.js';
import type { ProviderAdapter } from '../providers/types.js';
import { ProjectStateStore } from '../persistence/ProjectStateStore.js';
import { WorkspaceContextService } from '../workspace/WorkspaceContextService.js';
import { taskLikelyNeedsExternalAccess } from '../tools/toolCallLoop.js';

/** Maximum multi-turn iterations per task execution to prevent infinite loops. */
const MAX_MAILBOX_TURNS = 2;
/** Per-turn execution timeout in milliseconds (45 seconds). */
const EXECUTION_TIMEOUT_MS = 45_000;
/** Planning-call timeout in milliseconds (20 seconds). */
const PLAN_TIMEOUT_MS = 20_000;
/** Tasks active/queued longer than this (ms) are considered stale and auto-failed. */
const STALE_TASK_THRESHOLD_MS = 5 * 60_000;
/** Debounce interval for coalescing disk writes (ms). */
const SAVE_DEBOUNCE_MS = 500;

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
  private readonly scheduler = new TaskScheduler(6);
  private readonly mailbox = new AgentMailbox();
  private snapshot: WorkspaceSnapshot;
  readonly activityBus = new EventBus<ActivityMessage>();
  readonly taskOutputBus = new EventBus<TaskOutputMessage>();
  readonly agentChatBus = new EventBus<AgentChatMessage>();
  readonly streamBus = new EventBus<TaskStreamChunkMessage>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(rootPath?: string) {
    this.rootPath = rootPath;
    this.store = new ProjectStateStore(rootPath);
    this.workspaceContext = new WorkspaceContextService(rootPath);
    this.snapshot = this.loadSnapshot();
    this.reconcileAgentStatuses();
  }

  getSnapshot(): WorkspaceSnapshot {
    this.syncRuntimeProjection();
    return {
      ...this.snapshot,
      settings: this.getSettings(),
      roomFeeds: this.mailbox.getAllRoomFeeds(),
    };
  }

  getSettings() {
    const config = vscode.workspace.getConfiguration('pixelSquad');
    const settings = {
      autoExecute: config.get<boolean>('autoExecute', true),
      forceMcpForAllTasks: config.get<boolean>('forceMcpForAllTasks', false),
      modelFamily: config.get<string>('modelFamily', 'copilot'),
      copilotRuntime: config.get<'vscode-lm' | 'sdk-hybrid'>('copilotRuntime', 'sdk-hybrid'),
      autoPopulateWorkspaceContext: config.get<boolean>('autoPopulateWorkspaceContext', true),
      workspaceContextMaxFiles: config.get<number>('workspaceContextMaxFiles', 3),
    };
    this.copilot.setRuntime(settings.copilotRuntime);
    return settings;
  }

  /** Resolve a LanguageModelChat for the given provider (used for token counting). */
  private async resolveModelForAgent(provider: Provider): Promise<vscode.LanguageModelChat | undefined> {
    try {
      if (provider === 'claude') {
        const models = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
        if (models.length > 0) { return models[0]; }
        const all = await vscode.lm.selectChatModels();
        return all.find((m) =>
          m.family.toLowerCase().includes('claude') || m.vendor.toLowerCase().includes('anthropic'));
      }
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models[0];
    } catch {
      return undefined;
    }
  }

  async createTask(prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken, provider?: Provider, source: TaskSource = 'factory'): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'Pixel Squad ignored an empty task request.';
    }

    const settings = this.getSettings();
    // Use lightweight context for the planning call (only branch + activeFile are used in the prompt).
    // Start the full context fetch in parallel so it's ready by the time executeTask runs.
    const lightContext = this.workspaceContext.captureLightweight();
    const fullContextPromise = settings.autoPopulateWorkspaceContext
      ? this.workspaceContext.capture(normalizedPrompt, settings.workspaceContextMaxFiles)
      : Promise.resolve(undefined);
    const selectedProvider = provider ?? (this.getSettings().modelFamily as Provider) ?? 'copilot';
    const adapter = this.providers[selectedProvider] ?? this.copilot;
    const planPromise = adapter.createPlan(normalizedPrompt, this.snapshot.personas, lightContext, model, token);
    const planTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Planning timed out after ${PLAN_TIMEOUT_MS / 1000}s`)), PLAN_TIMEOUT_MS),
    );
    const plan = await Promise.race([planPromise, planTimeout]);
    const updatedAgents = [...this.snapshot.agents];
    const newTasks: TaskCard[] = [];
    const createdAt = Date.now();
    const batchId = this.makeId('batch');
    const stagedTaskIds = plan.assignments.map(() => this.makeId('task'));
    const personaTaskMap = new Map<string, string>();
    const autoExecute = settings.autoExecute;

    for (const [index, assignment] of plan.assignments.entries()) {
      // Load-balance across agents that share this persona so a split task
      // spreads work rather than piling on a single lane. Fall back to
      // auto-provisioning a fresh persona agent when the roster is missing it.
      const matchingAgents = updatedAgents
        .filter((item) => item.personaId === assignment.personaId)
        .sort((leftAgent, rightAgent) => this.openTaskCountForAgent(leftAgent.id) - this.openTaskCountForAgent(rightAgent.id));
      let agent: SquadAgent | undefined = matchingAgents[0];
      if (!agent) {
        const targetRoom = this.pickRoomForPersona(assignment.personaId);
        if (targetRoom) {
          const spawned = this.spawnAgent(targetRoom.id, '', assignment.personaId, selectedProvider, undefined, '', 'chat');
          if (spawned) {
            updatedAgents.push(spawned);
            agent = spawned;
            this.appendActivity(`Auto-provisioned ${spawned.name} for the ${assignment.personaId} lane to cover split stage "${assignment.title}".`, {
              category: 'agent',
              agentId: spawned.id,
              roomId: spawned.roomId,
              provider: spawned.provider,
            });
          }
        }
      }
      if (!agent) {
        agent = updatedAgents.find((item) => item.personaId === 'lead');
      }
      if (!agent) {
        continue;
      }

      const dependencyIds = assignment.dependsOnPersonaIds
        ?.map((personaId) => personaTaskMap.get(personaId))
        .filter((taskId): taskId is string => Boolean(taskId))
        ?? [];
      // Only use explicit dependencies — never force sequential chaining when
      // tasks could run in parallel on different agents.
      const inferredDependencyIds = dependencyIds;
      const { toolPreference, toolPreferenceReason } = this.resolveToolPreference(assignment.detail, settings.forceMcpForAllTasks);

      const nextStatus: TaskStatus = inferredDependencyIds.length === 0
        ? (autoExecute ? 'active' : 'queued')
        : 'queued';
      const refreshedAgent: SquadAgent = {
        ...agent,
        status: inferredDependencyIds.length === 0
          ? (autoExecute ? 'executing' : 'planning')
          : 'planning',
        summary: assignment.detail,
      };
      updatedAgents[updatedAgents.findIndex((item) => item.id === agent.id)] = refreshedAgent;

      newTasks.push({
        id: stagedTaskIds[index],
        title: assignment.title,
        status: nextStatus,
        assigneeId: refreshedAgent.id,
        provider: refreshedAgent.provider,
        source,
        detail: assignment.detail,
        dependsOn: inferredDependencyIds,
        requiredSkillIds: assignment.requiredSkillIds ?? [],
        toolPreference,
        toolPreferenceReason,
        workspaceContext: lightContext,
        progress: this.progressForStatus(nextStatus, assignment.progressLabel ?? (nextStatus === 'queued' ? 'Ready to start' : 'Executing'), undefined, 5),
        batchId,
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
    this.reconcileAgentStatuses(updatedAgents.map((item) => item.id));
    this.scheduleSave();
    this.appendActivity(`Task received: ${plan.title}`, { category: 'task', provider: selectedProvider });
    this.appendActivity(plan.providerDetail, { category: 'provider', provider: selectedProvider });
    if (newTasks.length > 0) {
      this.setUiFocus(newTasks[0].assigneeId, batchId);
      if (source !== 'factory') {
        this.appendSessionMessage(batchId, newTasks[0].assigneeId, 'user', normalizedPrompt, newTasks[0].id);
        const focusedAgent = updatedAgents.find((agent) => agent.id === newTasks[0].assigneeId);
        if (focusedAgent) {
          this.appendActivity(`Copilot Chat engaged ${focusedAgent.name} for run ${batchId}.`, {
            category: 'agent-chat',
            agentId: focusedAgent.id,
            roomId: focusedAgent.roomId,
            provider: focusedAgent.provider,
            taskId: newTasks[0].id,
          });
        }
      }
    }

    if (settings.autoPopulateWorkspaceContext && newTasks.length > 0) {
      void fullContextPromise.then((fullContext) => {
        if (!fullContext) {
          return;
        }
        for (const task of newTasks) {
          this.updateTask(task.id, { workspaceContext: fullContext });
        }
        this.scheduleSave();
      }).catch(() => undefined);
    }

    // Auto-execute all active (no-dep) tasks in parallel when enabled
    if (this.getSettings().autoExecute && newTasks.length > 0) {
      const activeTasks = newTasks.filter((t) => t.status === 'active');
      for (const t of activeTasks) {
        void this.executeTask(t.id, model, token);
      }
    }

    return `${plan.summary} ${plan.providerDetail}`;
  }

  async assignTask(agentId: string, prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken, source: TaskSource = 'factory', runIdOverride?: string, options?: { detail?: string; dependsOn?: string[]; title?: string }): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'Pixel Squad ignored an empty task.';
    }

    const agent = this.snapshot.agents.find((a) => a.id === agentId);
    if (!agent) {
      return 'Agent not found.';
    }

    // Optimistic: create the task immediately with lightweight context
    const lightContext = this.workspaceContext.captureLightweight();
    const settings = this.getSettings();
    const initialStatus: TaskStatus = settings.autoExecute ? 'active' : 'queued';
    const batchId = runIdOverride ?? this.makeId('run');
    const updatedAgent: SquadAgent = {
      ...agent,
      status: settings.autoExecute ? 'executing' : 'planning',
      summary: normalizedPrompt,
    };
    const { toolPreference, toolPreferenceReason } = this.resolveToolPreference(normalizedPrompt, settings.forceMcpForAllTasks);

    const task: TaskCard = {
      id: this.makeId('task'),
      title: options?.title?.trim() || (normalizedPrompt.length > 60 ? normalizedPrompt.slice(0, 57) + '...' : normalizedPrompt),
      status: initialStatus,
      assigneeId: agent.id,
      provider: agent.provider,
      source,
      detail: options?.detail?.trim() || normalizedPrompt,
      dependsOn: options?.dependsOn ?? [],
      requiredSkillIds: [],
      toolPreference,
      toolPreferenceReason,
      workspaceContext: lightContext,
      progress: this.progressForStatus(initialStatus, initialStatus === 'queued' ? 'Ready to start' : 'Preparing workspace'),
      batchId,
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
    this.reconcileAgentStatuses([agent.id]);
    this.scheduleSave();
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
    this.setUiFocus(agent.id, batchId);
    if (source !== 'factory') {
      this.appendSessionMessage(batchId, agent.id, 'user', normalizedPrompt, task.id);
    }
    if (source !== 'factory') {
      this.appendActivity(`Copilot Chat engaged ${agent.name}: ${normalizedPrompt}`, {
        category: 'agent-chat',
        agentId: agent.id,
        roomId: room?.id,
        provider: agent.provider,
        taskId: task.id,
      });
    }

    // Start execution immediately when auto-execute is on.
    // executeTask() can hydrate richer context in parallel, which avoids
    // paying the full workspace-context capture cost before the agent starts.
    if (settings.autoExecute) {
      void this.executeTask(task.id, model, token);
    } else if (settings.autoPopulateWorkspaceContext) {
      void (async () => {
        const contextModel = await this.resolveModelForAgent(agent.provider);
        const fullContext = await this.workspaceContext.capture(normalizedPrompt, settings.workspaceContextMaxFiles, agent.pinnedFiles, contextModel);
        this.updateTask(task.id, { workspaceContext: fullContext });
      })();
    }

    return runIdOverride
      ? `Message sent to ${agent.name} (${agent.provider}) in active run ${batchId}.`
      : `Task assigned to ${agent.name} (${agent.provider}).`;
  }

  async assignTaskToPersona(personaId: string, prompt: string, provider?: Provider, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken, source: TaskSource = 'factory'): Promise<string> {
    const persona = this.snapshot.personas.find((item) => item.id === personaId);
    if (!persona) {
      return 'Persona not found.';
    }

    const existingAgents = this.snapshot.agents
      .filter((agent) => agent.personaId === personaId)
      .sort((left, right) => this.openTaskCountForAgent(left.id) - this.openTaskCountForAgent(right.id));
    const focusedAgent = this.snapshot.ui.activeAgentId
      ? existingAgents.find((agent) => agent.id === this.snapshot.ui.activeAgentId)
      : undefined;
    let targetAgent = focusedAgent ?? existingAgents.find((agent) => agent.status === 'idle') ?? existingAgents[0];

    if (!targetAgent) {
      const targetRoom = this.pickRoomForPersona(personaId);
      const spawned = this.spawnAgent(targetRoom.id, '', personaId, provider ?? ((this.getSettings().modelFamily as Provider) ?? 'copilot'), undefined, '', 'chat');
      if (!spawned) {
        return `Unable to provision a ${persona.title} agent for this task.`;
      }
      targetAgent = spawned;
    }

    const activeRunId = source !== 'factory' && this.snapshot.ui.activeBatchId && this.hasAgentInRun(this.snapshot.ui.activeBatchId, targetAgent.id)
      ? this.snapshot.ui.activeBatchId
      : undefined;

    return this.assignTask(targetAgent.id, prompt, model, token, source, activeRunId);
  }

  async continueAgentSession(agentId: string, prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const activeRunId = this.snapshot.ui.activeBatchId && this.hasAgentInRun(this.snapshot.ui.activeBatchId, agentId)
      ? this.snapshot.ui.activeBatchId
      : this.pickFocusTaskForAgent(agentId)?.batchId;
    return this.assignTask(
      agentId,
      prompt,
      model,
      token,
      'copilot-chat',
      activeRunId,
      { detail: this.buildContinuationTaskDetail(agentId, prompt, activeRunId) },
    );
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

    const currentTask = this.snapshot.tasks.find((candidate) => candidate.id === taskId) ?? task;
    const workspaceContext = currentTask.workspaceContext ?? this.workspaceContext.captureLightweight();
    const shouldHydrateContext = this.getSettings().autoPopulateWorkspaceContext && workspaceContext.contextMode !== 'full';
    const room = this.snapshot.rooms.find((r) => r.id === agent.roomId);

    if (shouldHydrateContext) {
      void this.workspaceContext.capture(`${task.title}\n${task.detail}`, undefined, agent.pinnedFiles, model)
        .then((fullContext) => {
          this.updateTask(taskId, { workspaceContext: fullContext });
        })
        .catch(() => undefined);
    }

    // Collect handoff packets from completed predecessor tasks
    const handoffPackets = this.collectHandoffPackets(task);

    // Update task to active, agent to executing
    this.updateTask(taskId, {
      status: 'active',
      progress: this.progressForStatus('active', 'Preparing workspace', 2, 5),
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
    const pendingTaskRoutes: Array<{ personaId: string; title: string; detail: string }> = [];

    // ── Multi-turn mailbox execution loop ──
    let lastResult: import('../providers/types.js').ExecutionResult = { output: '', success: false };
    for (let turn = 0; turn < MAX_MAILBOX_TURNS; turn++) {
      // Keep task alive — the reaper uses updatedAt to detect stale work
      if (turn > 0) {
        this.updateTask(taskId, {
          progress: this.progressForStatus('active', `Agent turn ${turn + 1}/${MAX_MAILBOX_TURNS}`, 3, 5),
        });
      }
      const inboxMessages = this.mailbox.drain(agent.id);
      if (turn > 0 && inboxMessages.length === 0) {
        // No new messages arrived — no reason to keep looping
        break;
      }
      if (turn > 0) {
        this.appendActivity(`${agent.name} received ${inboxMessages.length} message(s) — executing turn ${turn + 1}.`, {
          category: 'agent-chat',
          agentId: agent.id,
          taskId,
          provider: task.provider,
        });
      }

      const executionTask = this.snapshot.tasks.find((candidate) => candidate.id === taskId) ?? { ...task, workspaceContext };
      const executionPromise = adapter.executeTask(
        executionTask, agent, persona, workspaceContext, model, token, room, handoffPackets,
        inboxMessages.length > 0 ? inboxMessages : undefined,
        (chunk) => this.streamBus.publish({ type: 'taskChunk', taskId, chunk }),
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timeout after ${EXECUTION_TIMEOUT_MS / 1000}s`)), EXECUTION_TIMEOUT_MS),
      );
      let result: import('../providers/types.js').ExecutionResult;
      try {
        result = await Promise.race([executionPromise, timeoutPromise]);
      } catch (timeoutErr) {
        const msg = timeoutErr instanceof Error ? timeoutErr.message : 'Execution timed out';
        lastResult = { output: msg, success: false };
        this.appendActivity(`${agent.name} timed out on turn ${turn + 1} of "${task.title}".`, {
          category: 'task', taskId, agentId: agent.id, provider: task.provider,
        });
        break;
      }
      lastResult = result;

      // Route outgoing agent messages through the mailbox
      if (result.outgoingMessages && result.outgoingMessages.length > 0) {
        for (const outMsg of result.outgoingMessages) {
          const agentMsg: AgentMessage = {
            id: `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            fromAgentId: agent.id,
            toAgentId: outMsg.toAgentId,
            roomId: agent.roomId,
            type: outMsg.type ?? 'inform',
            content: outMsg.content,
            taskId,
            timestamp: Date.now(),
          };
          this.mailbox.send(agentMsg);
          this.agentChatBus.publish({ type: 'agentChat', message: agentMsg });
          this.appendActivity(`💬 ${agent.name} → ${this.agentNameById(outMsg.toAgentId)}: ${outMsg.content.slice(0, 120)}`, {
            category: 'agent-chat',
            agentId: agent.id,
            taskId,
            provider: task.provider,
          });
        }
      }

      if (result.outgoingTaskRoutes && result.outgoingTaskRoutes.length > 0) {
        pendingTaskRoutes.push(...result.outgoingTaskRoutes);
      }

      // If the agent says it's done (or didn't set done=false), stop the loop
      if (result.done !== false) {
        break;
      }
    }

    const result = lastResult;
    const hydratedPlan = this.hydrateExecutionPlan(result.plan);

    if (result.success) {
      // When autoExecute is on, skip review and apply files immediately
      const autoApply = this.getSettings().autoExecute;
      const hasPlanArtifacts = hydratedPlan && (hydratedPlan.fileEdits.length > 0 || hydratedPlan.terminalCommands.length > 0);
      // When tool-calling already executed write operations, skip re-applying
      const alreadyApplied = result.toolsExecuted === true;

      if (alreadyApplied && hasPlanArtifacts) {
        // Tools already wrote files and/or ran commands — mark as done
        this.updateTask(taskId, {
          status: 'done',
          output: result.output,
          executionPlan: hydratedPlan,
          approvalState: 'applied',
          progress: this.progressForStatus('done'),
        });
        this.updateAgent(agent.id, { status: 'idle', summary: `Completed: ${task.title}` });
        this.appendActivity(`${agent.name} finished "${task.title}" — changes applied via tool calls.`, {
          category: 'task',
          taskId,
          agentId: agent.id,
          provider: task.provider,
        });
      } else if (autoApply && hasPlanArtifacts) {
        // Apply file edits and terminal commands immediately
        this.updateTask(taskId, {
          status: 'active',
          output: result.output,
          executionPlan: hydratedPlan,
          progress: this.progressForStatus('active', 'Applying changes', 4, 5),
        });
        const applied = await this.applyTaskPlan(
          this.snapshot.tasks.find((t) => t.id === taskId) ?? task,
        );

        if (applied) {
          // Run terminal commands after file edits land.
          // Serve/dev-server commands launch in a visible VS Code terminal;
          // one-shot commands (build, install, test) are captured via exec().
          const taskWithPlan = this.snapshot.tasks.find((t) => t.id === taskId);
          if (taskWithPlan && (taskWithPlan.executionPlan?.terminalCommands.length ?? 0) > 0) {
            await this.runTaskCommands(taskWithPlan);
          }

          this.updateTask(taskId, {
            status: 'done',
            output: result.output,
            // executionPlan is not overwritten here — runTaskCommands already
            // populated commandResults inside it.
            approvalState: 'applied',
            progress: this.progressForStatus('done', 'Complete', 5, 5),
          });
          this.updateAgent(agent.id, { status: 'idle', summary: `Completed: ${task.title}` });
          this.appendActivity(`${agent.name} finished "${task.title}" — changes auto-applied.`, {
            category: 'task',
            taskId,
            agentId: agent.id,
            provider: task.provider,
          });
        } else {
          // Auto-apply failed (e.g. no workspace root); still complete — don't block on review
          this.updateTask(taskId, {
            status: 'done',
            output: result.output,
            executionPlan: hydratedPlan,
            approvalState: 'applied',
            progress: this.progressForStatus('done'),
          });
          this.updateAgent(agent.id, { status: 'idle', summary: `Completed: ${task.title}` });
          this.appendActivity(`${agent.name} finished "${task.title}" — plan prepared (no workspace root to write files).`, {
            category: 'task',
            taskId,
            agentId: agent.id,
            provider: task.provider,
          });
        }
      } else {
        this.updateTask(taskId, {
          status: autoApply ? 'done' : 'review',
          output: result.output,
          executionPlan: hydratedPlan,
          approvalState: hasPlanArtifacts ? (autoApply ? 'applied' : 'pending') : undefined,
          progress: this.progressForStatus(autoApply ? 'done' : 'review', autoApply ? 'Complete' : 'Ready for review', autoApply ? 5 : 4, 5),
        });
        this.updateAgent(agent.id, {
          status: autoApply ? 'idle' : 'waiting',
          summary: autoApply ? `Completed: ${task.title}` : `Completed: ${task.title} — awaiting review.`,
        });
        this.appendActivity(`${agent.name} finished "${task.title}"${autoApply ? '.' : ' — moved to review.'}`, {
          category: 'task',
          taskId,
          agentId: agent.id,
          provider: task.provider,
        });
      }

      const completedTask = this.snapshot.tasks.find((candidate) => candidate.id === taskId) ?? task;
      if (pendingTaskRoutes.length > 0) {
        for (const route of pendingTaskRoutes) {
          this.queueFollowupTaskRoute(completedTask, agent, route);
        }
      }

      // Broadcast task completion to room peers so they can pick up context
      if (room) {
        this.mailbox.broadcastToRoom(agent.id, room.id, room.agentIds, `I finished "${task.title}": ${result.output.slice(0, 200)}`, 'inform', taskId);
        // Update idle/waiting peers' summaries so the inspector panel reflects
        // the completion immediately — without waiting for a future task execution.
        this.notifyRoomPeersOfCompletion(agent.id, room.agentIds, task.title);
        this.scheduleSave();
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

    if (task.batchId) {
      this.appendSessionMessage(task.batchId, agent.id, 'agent', result.output.slice(0, 2000), taskId);
    }

    this.scheduler.finish(taskId);
    this.taskOutputBus.publish({ type: 'taskOutput', taskId, output: result.output });
    this.flushSave();

    // Status bar flash — instant feedback for every completion
    if (result.success) {
      vscode.window.setStatusBarMessage(`$(check) ${agent.name} finished "${task.title}"`, 5000);
    }

    // Batch completion notification — fire once when ALL tasks in the batch are done
    this.notifyBatchCompletionIfReady(task);

    // Auto-promote downstream tasks whose dependencies are now met
    this.promoteReadyTasks();

    return result.output;
  }

  /**
   * Fleet mode: splits a prompt across ALL available idle agents in parallel.
   * Each agent gets the same prompt and executes simultaneously.
   */
  async fleetExecute(prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) { return 'Fleet ignored an empty prompt.'; }

    const idleAgents = this.snapshot.agents.filter((a) => a.status === 'idle');
    if (idleAgents.length === 0) { return 'No idle agents available for fleet execution.'; }

    const batchId = this.makeId('fleet');
    const createdAt = Date.now();
    const tasks: TaskCard[] = [];
    const lightContext = this.workspaceContext.captureLightweight();
    const { toolPreference, toolPreferenceReason } = this.resolveToolPreference(normalizedPrompt, this.getSettings().forceMcpForAllTasks);

    for (const agent of idleAgents) {
      const persona = this.snapshot.personas.find((p) => p.id === agent.personaId);
      if (!persona) { continue; }
      const task: TaskCard = {
        id: this.makeId('task'),
        title: normalizedPrompt.length > 60 ? normalizedPrompt.slice(0, 57) + '...' : normalizedPrompt,
        status: 'active',
        assigneeId: agent.id,
        provider: agent.provider,
        source: 'factory',
        detail: `[Fleet] ${normalizedPrompt}`,
        dependsOn: [],
        requiredSkillIds: [],
        toolPreference,
        toolPreferenceReason,
        workspaceContext: lightContext,
        progress: this.progressForStatus('active', 'Fleet executing'),
        batchId,
        createdAt,
        updatedAt: createdAt,
      };
      tasks.push(task);
      this.updateAgent(agent.id, { status: 'executing', summary: `Fleet: ${normalizedPrompt.slice(0, 60)}` });
    }

    this.snapshot = {
      ...this.snapshot,
      tasks: [...tasks, ...this.snapshot.tasks].slice(0, 40),
    };
    this.scheduleSave();
    this.appendActivity(`Fleet launched: ${tasks.length} agent(s) executing in parallel.`, { category: 'task' });

    // Fire all executions in parallel (non-blocking)
    for (const task of tasks) {
      void this.executeTask(task.id, model, token);
    }

    return `Fleet mode: ${tasks.length} agents executing "${normalizedPrompt.slice(0, 60)}" in parallel.`;
  }

  /**
   * Detect and fail tasks that have been active for too long with no progress.
   * Called periodically or on snapshot refresh.
   */
  reapStaleTasks(): number {
    const now = Date.now();
    let reaped = 0;
    // Reap tasks stuck in active OR queued states
    const staleCandidates = this.snapshot.tasks.filter((t) => t.status === 'active' || t.status === 'queued');
    for (const task of staleCandidates) {
      // Never reap tasks the scheduler knows are actively executing
      if (this.scheduler.isRunning(task.id)) {
        continue;
      }
      const elapsed = now - (task.updatedAt ?? task.createdAt ?? now);
      if (elapsed > STALE_TASK_THRESHOLD_MS) {
        this.updateTask(task.id, {
          status: 'failed',
          output: `Task timed out after ${Math.round(elapsed / 60_000)} minutes with no progress.`,
          progress: this.progressForStatus('failed', 'Timed out'),
        });
        const agent = this.snapshot.agents.find((a) => a.id === task.assigneeId);
        if (agent && (agent.status === 'executing' || agent.status === 'planning')) {
          this.updateAgent(agent.id, { status: 'idle', summary: `Recovered from stale: ${task.title}` });
        }
        this.scheduler.finish(task.id);
        this.appendActivity(`Reaped stale task "${task.title}" (stuck for ${Math.round(elapsed / 60_000)}min).`, {
          category: 'task', taskId: task.id, provider: task.provider,
        });
        reaped++;
      }
    }
    // Also recover agents stuck in planning/executing with no matching active task
    for (const agent of this.snapshot.agents) {
      if (agent.status === 'planning' || agent.status === 'executing') {
        const hasActiveTask = this.snapshot.tasks.some((t) =>
          t.assigneeId === agent.id && (t.status === 'active' || t.status === 'queued'),
        );
        if (!hasActiveTask) {
          this.updateAgent(agent.id, { status: 'idle', summary: 'Recovered — no active work found.' });
          reaped++;
        }
      }
    }
    if (reaped > 0) {
      this.flushSave();
      this.promoteReadyTasks();
    }
    return reaped;
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
    this.scheduleSave();
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
      // Move assigned agent to idle
      const agent = this.snapshot.agents.find((a) => a.id === task.assigneeId);
      if (agent) {
        this.updateAgent(agent.id, { status: 'idle', summary: `Completed: ${task.title}` });
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
    this.scheduleSave();

    // When a task completes, check if downstream tasks are now unblocked
    if (action === 'complete') {
      this.promoteReadyTasks();
      // Notify idle/waiting room peers so their inspector summary updates
      const assignee = this.snapshot.agents.find((a) => a.id === task.assigneeId);
      const completionRoom = assignee && this.snapshot.rooms.find((r) => r.id === assignee.roomId);
      if (assignee && completionRoom) {
        this.notifyRoomPeersOfCompletion(assignee.id, completionRoom.agentIds, task.title);
        this.scheduleSave();
      }
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
    this.scheduleSave();
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
    this.scheduleSave();
  }

  /* ── Agent spawning ───────────────────────────────── */

  spawnAgent(roomId: string, name: string, personaId: string, provider: Provider, customPersona?: CustomPersonaDraft, assignTaskId?: string, spawnSource: 'panel' | 'chat' = 'panel'): SquadAgent | undefined {
    const room = this.snapshot.rooms.find((r) => r.id === roomId);
    if (!room) return undefined;

    const nextPersona = customPersona ? this.ensureCustomPersona(customPersona) : undefined;
    const resolvedPersonaId = nextPersona?.id ?? personaId;
    const persona = this.snapshot.personas.find((p) => p.id === resolvedPersonaId) ?? nextPersona;
    if (!persona) return undefined;

    const queuedRoomTasks = this.snapshot.tasks.filter((task) =>
      task.status === 'queued' && this.snapshot.agents.find((existing) => existing.id === task.assigneeId)?.roomId === roomId,
    );
    const selectedTaskId = assignTaskId === ''
      ? undefined
      : (assignTaskId ?? (spawnSource === 'panel' ? queuedRoomTasks[0]?.id : undefined));

    const agent: SquadAgent = {
      id: this.makeId('agent'),
      name: name.trim() || `${persona.title}-${room.agentIds.length + 1}`,
      personaId: resolvedPersonaId,
      provider,
      status: 'idle',
      roomId,
      summary: `Ready for ${persona.specialty.toLowerCase()} tasks.`,
      spriteVariant: Math.floor(Math.random() * 4),
      pinnedFiles: [],
    };

    this.snapshot = {
      ...this.snapshot,
      personas: nextPersona ? [...this.snapshot.personas.filter((entry) => entry.id !== nextPersona.id), nextPersona] : this.snapshot.personas,
      agents: [...this.snapshot.agents, agent],
      rooms: this.snapshot.rooms.map((r) =>
        r.id === roomId ? { ...r, agentIds: [...r.agentIds, agent.id] } : r,
      ),
    };

    if (selectedTaskId) {
      const reassignedTask = this.snapshot.tasks.find((task) => task.id === selectedTaskId);
      if (reassignedTask && reassignedTask.status === 'queued') {
        const previousAssigneeId = reassignedTask.assigneeId;
        const pinnedFiles = this.extractPinnedFilesFromTaskContext(reassignedTask);
        this.snapshot = {
          ...this.snapshot,
          agents: this.snapshot.agents.map((existingAgent) =>
            existingAgent.id === agent.id
              ? {
                  ...existingAgent,
                  pinnedFiles: Array.from(new Set([...(existingAgent.pinnedFiles ?? []), ...pinnedFiles])),
                  summary: `Picked up queued task: ${reassignedTask.title}`,
                }
              : existingAgent,
          ),
          tasks: this.snapshot.tasks.map((task) =>
            task.id === selectedTaskId
              ? {
                  ...task,
                  assigneeId: agent.id,
                  progress: this.progressForStatus('queued', 'Assigned to new agent with context', 1, 5),
                  updatedAt: Date.now(),
                }
              : task,
          ),
        };
        this.appendActivity(`Queued task "${reassignedTask.title}" was assigned to ${agent.name} during spawn.`, {
          category: 'task',
          taskId: reassignedTask.id,
          agentId: agent.id,
          roomId,
          provider,
        });
        this.reconcileAgentStatuses([previousAssigneeId, agent.id]);
      }
    }

    this.appendActivity(`Agent "${agent.name}" spawned in "${room.name}" (${provider}).`, {
      category: 'agent',
      agentId: agent.id,
      roomId,
      provider,
    });
    this.reconcileAgentStatuses([agent.id]);
    this.scheduleSave();
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
    this.scheduleSave();
  }

  pinFiles(agentId: string, files: string[]): void {
    const agent = this.snapshot.agents.find((a) => a.id === agentId);
    if (!agent) return;

    // Validate paths exist and are within the workspace
    const validFiles = files.filter((filePath) => {
      if (!this.rootPath) return false;
      const absolute = path.resolve(this.rootPath, filePath);
      return absolute.startsWith(path.resolve(this.rootPath)) && fs.existsSync(absolute);
    });

    this.updateAgent(agentId, { pinnedFiles: validFiles });
    this.appendActivity(`${agent.name}: pinned ${validFiles.length} workspace file(s).`, {
      category: 'agent',
      agentId,
      provider: agent.provider,
    });
    this.scheduleSave();
  }

  /** Return workspace-relative file paths for the picker. */
  async getWorkspaceFiles(): Promise<string[]> {
    return this.workspaceContext.listWorkspaceFiles();
  }

  resetWorkspace(): void {
    const snapshot = this.store.reset();
    this.snapshot = {
      ...snapshot,
      providers: this.getProviderHealths(),
      settings: this.getSettings(),
    };
    this.reconcileAgentStatuses();
    this.mailbox.clear();
    this.flushSave();
  }

  notifyWebviewConnected(): void {
    this.appendActivity('Factory panel connected to coordinator.', { category: 'system' });
  }

  selectAgent(agentId: string): void {
    const focusTask = this.pickFocusTaskForAgent(agentId);
    this.setUiFocus(agentId, focusTask?.batchId);
    this.appendActivity(`Inspector focused on ${agentId}.`, { category: 'agent', agentId, taskId: focusTask?.id });
    this.scheduleSave();
  }

  private updateTask(taskId: string, updates: Partial<TaskCard>): void {
    const currentTask = this.snapshot.tasks.find((task) => task.id === taskId);
    this.snapshot = {
      ...this.snapshot,
      tasks: this.snapshot.tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
      ),
    };
    if (currentTask) {
      this.reconcileAgentStatuses([currentTask.assigneeId]);
    }
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
    this.snapshot = {
      ...snapshot,
      providers: this.getProviderHealths(),
      settings: snapshot.settings ?? this.getSettings(),
      ui: snapshot.ui ?? {},
      roomFeeds: snapshot.roomFeeds ?? {},
    };
    this.syncRuntimeProjection();
    return this.snapshot;
  }

  private setUiFocus(agentId?: string, batchId?: string): void {
    this.snapshot = {
      ...this.snapshot,
      ui: {
        ...this.snapshot.ui,
        activeAgentId: agentId,
        activeBatchId: batchId,
      },
    };
  }

  private pickFocusTaskForAgent(agentId: string): TaskCard | undefined {
    const tasks = this.snapshot.tasks
      .filter((task) => task.assigneeId === agentId)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return tasks.find((task) => task.status === 'active')
      ?? tasks.find((task) => task.status === 'review')
      ?? tasks.find((task) => task.status === 'queued')
      ?? tasks[0];
  }

  private buildContinuationTaskDetail(agentId: string, prompt: string, runId?: string): string {
    const focusTask = this.pickFocusTaskForAgent(agentId);
    const session = runId ? this.snapshot.agentSessions.find((entry) => entry.runId === runId && entry.agentId === agentId) : undefined;
    const recentMessages = session?.messageLog.slice(-4).map((message) => {
      const role = message.role === 'user' ? 'User' : message.role === 'agent' ? 'Agent' : 'System';
      return `${role}: ${message.content}`;
    }) ?? [];
    const changedFiles = focusTask?.executionPlan?.fileEdits.map((edit) => edit.filePath) ?? [];
    const handoffSummaries = focusTask?.handoffPackets?.map((packet) => packet.summary) ?? [];

    return [
      prompt.trim(),
      focusTask ? `\nCurrent lane focus: ${focusTask.title}` : '',
      focusTask?.detail ? `Focus detail: ${focusTask.detail}` : '',
      focusTask?.output ? `Latest lane output: ${focusTask.output.slice(0, 500)}` : '',
      changedFiles.length > 0 ? `Relevant changed files: ${changedFiles.slice(0, 4).join(', ')}` : '',
      handoffSummaries.length > 0 ? `Predecessor handoff: ${handoffSummaries.slice(0, 2).join(' | ')}` : '',
      recentMessages.length > 0 ? `Recent lane transcript:\n${recentMessages.join('\n')}` : '',
      'Treat this as a continuation of the same lane and build directly on the existing run context.',
    ].filter(Boolean).join('\n');
  }

  private getProviderHealths(): ProviderHealth[] {
    return [this.copilot.getHealth(), this.claude.getHealth()];
  }

  /** Coalesce saves — write to disk at most once per SAVE_DEBOUNCE_MS. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.syncRuntimeProjection();
      this.store.saveAsync(this.snapshot);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Force an immediate synchronous save and cancel any pending debounce. */
  private flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.syncRuntimeProjection();
    this.store.save(this.snapshot);
  }

  private hasAgentInRun(runId: string, agentId: string): boolean {
    return this.snapshot.tasks.some((task) => (task.batchId ?? task.id) === runId && task.assigneeId === agentId);
  }

  private appendSessionMessage(runId: string, agentId: string, role: AgentSessionMessageRole, content: string, taskId?: string): void {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    const sessionId = `session:${runId}:${agentId}`;
    const existing = this.snapshot.agentSessions.find((session) => session.id === sessionId);
    const agent = this.snapshot.agents.find((item) => item.id === agentId);
    const nextMessage: AgentSessionMessage = {
      id: `session-message-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      role,
      content: trimmed,
      timestamp: Date.now(),
      taskId,
    };

    const messageLog = [...(existing?.messageLog ?? []), nextMessage].slice(-20);
    const session: AgentSession = {
      id: sessionId,
      runId,
      agentId,
      personaId: agent?.personaId ?? existing?.personaId ?? 'unknown',
      provider: agent?.provider ?? existing?.provider ?? 'copilot',
      status: existing?.status ?? 'queued',
      startedAt: existing?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      messageLog,
    };

    this.snapshot = {
      ...this.snapshot,
      agentSessions: [
        session,
        ...this.snapshot.agentSessions.filter((item) => item.id !== sessionId),
      ],
    };
  }

  private syncRuntimeProjection(): void {
    const existingSessions = new Map(this.snapshot.agentSessions.map((session) => [session.id, session]));
    const tasksByRun = new Map<string, TaskCard[]>();

    for (const task of this.snapshot.tasks) {
      const runId = task.batchId ?? task.id;
      const current = tasksByRun.get(runId);
      if (current) {
        current.push(task);
      } else {
        tasksByRun.set(runId, [task]);
      }
    }

    const runs: RunRecord[] = Array.from(tasksByRun.entries()).map(([runId, tasks]) => {
      const orderedTasks = [...tasks].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
      const stages: RunStage[] = orderedTasks.map((task) => ({
        id: `stage:${task.id}`,
        taskId: task.id,
        title: task.title,
        detail: task.detail,
        status: task.status,
        agentId: task.assigneeId,
        provider: task.provider,
        source: task.source,
        dependsOnTaskIds: task.dependsOn ?? [],
        createdAt: task.createdAt ?? 0,
        updatedAt: task.updatedAt ?? task.createdAt ?? 0,
      }));
      const leadTask = orderedTasks[0];

      return {
        id: runId,
        title: leadTask.title,
        summary: leadTask.detail,
        status: this.runStatusForTasks(orderedTasks),
        source: leadTask.source,
        createdAt: Math.min(...orderedTasks.map((task) => task.createdAt ?? Date.now())),
        updatedAt: Math.max(...orderedTasks.map((task) => task.updatedAt ?? task.createdAt ?? Date.now())),
        stages,
        activeAgentIds: Array.from(new Set(orderedTasks.map((task) => task.assigneeId))),
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt);

    const sessions: AgentSession[] = [];
    for (const run of runs) {
      for (const agentId of run.activeAgentIds) {
        const sessionId = `session:${run.id}:${agentId}`;
        const existing = existingSessions.get(sessionId);
        const agent = this.snapshot.agents.find((item) => item.id === agentId);
        const sessionTasks = this.snapshot.tasks.filter((task) => (task.batchId ?? task.id) === run.id && task.assigneeId === agentId);
        sessions.push({
          id: sessionId,
          runId: run.id,
          agentId,
          personaId: agent?.personaId ?? existing?.personaId ?? 'unknown',
          provider: agent?.provider ?? existing?.provider ?? 'copilot',
          status: this.sessionStatusForTasks(sessionTasks),
          startedAt: existing?.startedAt ?? Math.min(...sessionTasks.map((task) => task.createdAt ?? Date.now())),
          updatedAt: Math.max(existing?.updatedAt ?? 0, ...sessionTasks.map((task) => task.updatedAt ?? task.createdAt ?? Date.now())),
          messageLog: existing?.messageLog ?? [],
        });
      }
    }

    this.snapshot = {
      ...this.snapshot,
      runs,
      agentSessions: sessions.sort((left, right) => right.updatedAt - left.updatedAt),
    };
  }

  private runStatusForTasks(tasks: TaskCard[]): RunStatus {
    if (tasks.some((task) => task.status === 'active')) return 'active';
    if (tasks.some((task) => task.status === 'review')) return 'review';
    if (tasks.some((task) => task.status === 'failed')) return 'failed';
    if (tasks.some((task) => task.status === 'queued')) return 'queued';
    return 'done';
  }

  private sessionStatusForTasks(tasks: TaskCard[]): AgentSessionStatus {
    if (tasks.some((task) => task.status === 'active')) return 'active';
    if (tasks.some((task) => task.status === 'review')) return 'review';
    if (tasks.some((task) => task.status === 'failed')) return 'failed';
    if (tasks.some((task) => task.status === 'queued')) return 'queued';
    return 'done';
  }

  /** Flush any pending debounced save before the extension is torn down. */
  dispose(): void {
    this.flushSave();
  }

  private appendActivity(
    message: string,
    metadata: Partial<Omit<ActivityEntry, 'id' | 'message' | 'timestamp' | 'category'>> & { category?: ActivityCategory } = {},
  ): void {
    const activity = createActivityEntry(message, metadata.category ?? 'system', metadata);
    this.snapshot = {
      ...this.snapshot,
      activityFeed: [activity, ...this.snapshot.activityFeed].slice(0, 20),
    };
    this.scheduleSave();
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

  private progressForStatus(status: TaskStatus, label?: string, value?: number, total = 5): TaskProgress {
    switch (status) {
      case 'queued':
        return { value: value ?? 1, total, label: label ?? 'Queued' };
      case 'active':
        return { value: value ?? 2, total, label: label ?? 'Executing' };
      case 'review':
        return { value: value ?? 4, total, label: label ?? 'Review' };
      case 'done':
        return { value: value ?? total, total, label: label ?? 'Complete' };
      case 'failed':
        return { value: value ?? total, total, label: label ?? 'Failed' };
    }
  }

  private openTaskCountForAgent(agentId: string): number {
    return this.snapshot.tasks.filter((task) =>
      task.assigneeId === agentId && task.status !== 'done' && task.status !== 'failed',
    ).length;
  }

  private queueFollowupTaskRoute(
    sourceTask: TaskCard,
    sourceAgent: SquadAgent,
    route: { personaId: string; title: string; detail: string },
  ): void {
    const persona = this.snapshot.personas.find((entry) => entry.id === route.personaId);
    if (!persona) {
      this.appendActivity(`Skipped downstream route from ${sourceAgent.name}: unknown persona "${route.personaId}".`, {
        category: 'task',
        taskId: sourceTask.id,
        agentId: sourceAgent.id,
        provider: sourceTask.provider,
      });
      return;
    }

    const existingFollowup = this.snapshot.tasks.find((task) =>
      task.batchId === sourceTask.batchId
      && task.assigneeId !== sourceAgent.id
      && this.snapshot.agents.find((agent) => agent.id === task.assigneeId)?.personaId === route.personaId
      && task.title.trim().toLowerCase() === route.title.trim().toLowerCase()
      && task.status !== 'failed',
    );
    if (existingFollowup) {
      return;
    }

    let targetAgent = this.snapshot.agents
      .filter((agent) => agent.personaId === route.personaId)
      .sort((left, right) => this.openTaskCountForAgent(left.id) - this.openTaskCountForAgent(right.id))[0];

    if (!targetAgent) {
      const targetRoom = this.pickRoomForPersona(route.personaId);
      const spawnedAgent = this.spawnAgent(targetRoom.id, '', route.personaId, sourceAgent.provider, undefined, '', 'chat');
      if (!spawnedAgent) {
        return;
      }
      targetAgent = spawnedAgent;
    }

    const queuedTask: TaskCard = {
      id: this.makeId('task'),
      title: route.title.trim(),
      status: 'queued',
      assigneeId: targetAgent.id,
      provider: targetAgent.provider,
      source: sourceTask.source,
      detail: `${route.detail.trim()}\n\nAuto-routed from ${sourceAgent.name} after completing "${sourceTask.title}".`,
      dependsOn: [sourceTask.id],
      requiredSkillIds: [],
      toolPreference: sourceTask.toolPreference,
      toolPreferenceReason: sourceTask.toolPreferenceReason,
      workspaceContext: sourceTask.workspaceContext,
      handoffPackets: this.collectHandoffPackets(sourceTask).concat({
        fromTaskId: sourceTask.id,
        fromAgentName: sourceAgent.name,
        summary: sourceTask.executionPlan?.summary ?? sourceTask.detail,
        filesChanged: sourceTask.executionPlan?.fileEdits.map((edit) => edit.filePath) ?? [],
        commandsRun: sourceTask.executionPlan?.terminalCommands.map((command) => command.command) ?? [],
        testsRun: sourceTask.executionPlan?.tests ?? [],
        openIssues: sourceTask.executionPlan?.notes ?? [],
        output: sourceTask.output ?? '',
      }),
      progress: this.progressForStatus('queued', 'Waiting for predecessor handoff', 1, 5),
      batchId: sourceTask.batchId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.snapshot = {
      ...this.snapshot,
      tasks: [queuedTask, ...this.snapshot.tasks].slice(0, 60),
    };
    this.reconcileAgentStatuses([targetAgent.id]);
    this.appendActivity(`Auto-routed "${queuedTask.title}" to ${targetAgent.name} (${persona.title}) after ${sourceAgent.name} completed "${sourceTask.title}".`, {
      category: 'task',
      taskId: queuedTask.id,
      agentId: targetAgent.id,
      roomId: targetAgent.roomId,
      provider: targetAgent.provider,
    });
    this.scheduleSave();
  }

  private pickRoomForPersona(personaId: string): Room {
    const preferredThemeByPersona: Partial<Record<string, RoomTheme>> = {
      lead: 'general',
      frontend: 'frontend',
      backend: 'backend',
      tester: 'testing',
      devops: 'devops',
      designer: 'design',
    };
    const preferredTheme = preferredThemeByPersona[personaId] ?? 'general';
    return this.snapshot.rooms.find((room) => room.theme === preferredTheme)
      ?? this.snapshot.rooms.find((room) => room.theme === 'general')
      ?? this.snapshot.rooms[0];
  }

  private extractPinnedFilesFromTaskContext(task: TaskCard): string[] {
    const files = [
      ...(task.workspaceContext?.activeFile ? [task.workspaceContext.activeFile] : []),
      ...(task.workspaceContext?.relevantFiles.map((file) => file.path) ?? []),
      ...(task.handoffPackets?.flatMap((packet) => packet.filesChanged) ?? []),
    ].filter((value): value is string => Boolean(value));
    return Array.from(new Set(files));
  }

  private reconcileAgentStatuses(agentIds?: string[]): void {
    const targets = agentIds ? new Set(agentIds) : undefined;
    this.snapshot = {
      ...this.snapshot,
      agents: this.snapshot.agents.map((agent) => {
        if (targets && !targets.has(agent.id)) {
          return agent;
        }

        if (agent.status === 'paused' || agent.status === 'blocked') {
          return agent;
        }

        const assignedTasks = this.snapshot.tasks.filter((task) =>
          task.assigneeId === agent.id && task.status !== 'done' && task.status !== 'failed',
        );
        const hasFailedTask = this.snapshot.tasks.some((task) => task.assigneeId === agent.id && task.status === 'failed');

        let nextStatus: AgentStatus;
        if (assignedTasks.some((task) => task.status === 'active')) {
          nextStatus = 'executing';
        } else if (assignedTasks.some((task) => task.status === 'review')) {
          nextStatus = 'waiting';
        } else if (assignedTasks.some((task) => task.status === 'queued')) {
          nextStatus = 'planning';
        } else if (agent.status === 'completed') {
          nextStatus = 'completed';
        } else if (agent.status === 'failed' && hasFailedTask) {
          nextStatus = 'failed';
        } else {
          nextStatus = 'idle';
        }

        if (nextStatus === agent.status) {
          return agent;
        }

        return {
          ...agent,
          status: nextStatus,
        };
      }),
    };
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

      // Use Node fs directly to avoid opening files in editor tabs
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(targetPath, proposedEdit.content, 'utf8');
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

  private agentNameById(agentId: string): string {
    return this.snapshot.agents.find((a) => a.id === agentId)?.name ?? agentId;
  }

  private resolveToolPreference(detail: string, forceMcpForAllTasks: boolean): {
    toolPreference: ToolPreference;
    toolPreferenceReason?: ToolPreferenceReason;
  } {
    if (forceMcpForAllTasks) {
      return { toolPreference: 'mcp-first', toolPreferenceReason: 'forced' };
    }
    if (taskLikelyNeedsExternalAccess(detail)) {
      return { toolPreference: 'mcp-first', toolPreferenceReason: 'external-access' };
    }
    return { toolPreference: 'workspace-first' };
  }

  /**
   * Fire a VS Code information notification once when every task in the same
   * batch (same batchId) has reached 'done' or 'failed'. Only fires once per
   * batch to avoid spamming the user.
   */
  private notifyBatchCompletionIfReady(completedTask: TaskCard): void {
    const batchId = completedTask.batchId;
    if (!batchId) {
      return;
    }

    const batchTasks = this.snapshot.tasks.filter((t) => t.batchId === batchId);
    if (batchTasks.length === 0) {
      return;
    }

    const allSettled = batchTasks.every((t) => t.status === 'done' || t.status === 'failed' || t.status === 'review');
    if (!allSettled) {
      return;
    }

    const doneCount = batchTasks.filter((t) => t.status === 'done').length;
    const failedCount = batchTasks.filter((t) => t.status === 'failed').length;
    const reviewCount = batchTasks.filter((t) => t.status === 'review').length;

    const parts = [
      doneCount > 0 ? `${doneCount} done` : '',
      reviewCount > 0 ? `${reviewCount} needs review` : '',
      failedCount > 0 ? `${failedCount} failed` : '',
    ].filter(Boolean).join(' · ');

    const label = failedCount === 0 && reviewCount === 0 ? '$(check-all) Pixel Squad' : '$(warning) Pixel Squad';
    const btnLabel = reviewCount > 0 ? 'Open Panel' : undefined;

    void vscode.window.showInformationMessage(
      `${label}: all ${batchTasks.length} agent task(s) settled — ${parts}.`,
      ...(btnLabel ? [btnLabel] : []),
    ).then((selection) => {
      if (selection === 'Open Panel') {
        void vscode.commands.executeCommand('pixelSquad.openInEditor');
      }
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
      // Long-running dev servers and app launchers go to a visible VS Code terminal.
      // They are fire-and-forget — we mark them succeeded immediately.
      if (this.isServeCommand(command.command)) {
        this.launchInTerminal(command.command, `Pixel Squad · ${task.title}`);
        const now = Date.now();
        results = results.map((result) => result.commandIndex === index
          ? {
              ...result,
              status: 'succeeded',
              exitCode: 0,
              stdout: `Command launched in VS Code terminal: "${command.command}"`,
              startedAt: now,
              completedAt: now,
              durationMs: 0,
            }
          : result);
        this.appendActivity(`Launched "${command.command}" in a VS Code terminal for "${task.title}".`, {
          category: 'task',
          taskId: task.id,
          provider: task.provider,
        });
        this.updateTask(task.id, { executionPlan: { ...plan, commandResults: results } });
        this.scheduleSave();
        continue;
      }

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
      this.scheduleSave();

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
        this.scheduleSave();
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
    this.scheduleSave();
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

  /**
   * Returns true when the command is a long-running serve/dev-server command
   * that should be launched in a visible VS Code terminal rather than via exec().
   */
  private isServeCommand(command: string): boolean {
    const servePatterns = [
      /\bnpm\s+(run\s+)?(dev|start|serve|preview|watch)\b/i,
      /\bpnpm\s+(run\s+)?(dev|start|serve|preview|watch)\b/i,
      /\byarn\s+(run\s+)?(dev|start|serve|preview|watch)\b/i,
      /\bbun\s+(run\s+)?(dev|start|serve|preview|watch)\b/i,
      /\bvite(?!\s+build)\b/i,
      /\bnext\s+(dev|start)\b/i,
      /\bnuxt\s+(dev|start)\b/i,
      /\bpython3?\s+.*manage\.py\s+runserver\b/i,
      /\bflask\s+run\b/i,
      /\buvicorn\b/i,
      /\bfastapi\s+dev\b/i,
      /\bnode\s+[\w./]+\.(js|ts)\b/i,
      /\bdocker\s+(compose\s+)?up\b/i,
      /\bdotnet\s+(run|watch)\b/i,
      /\bcargo\s+run\b/i,
      /\bgo\s+run\b/i,
      /\bruby.*rails\s+server\b/i,
      /\bphp\s+.*artisan\s+serve\b/i,
      /\blive-server\b/i,
      /\bhttp-server\b/i,
    ];
    return servePatterns.some((pattern) => pattern.test(command));
  }

  /**
   * Open a named VS Code integrated terminal, show it to the user,
   * and send the given command to it.  Used for long-running serve commands
   * so the user can see the output and the process stays alive.
   */
  private launchInTerminal(command: string, terminalName: string): void {
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: this.rootPath,
    });
    terminal.show();
    terminal.sendText(command);
  }

  /**
   * When a task completes, update the summary of idle/waiting peers in the same
   * room so they are visually aware in the inspector without needing active
   * mailbox polling.
   */
  private notifyRoomPeersOfCompletion(
    completingAgentId: string,
    roomAgentIds: string[],
    taskTitle: string,
  ): void {
    const completingAgent = this.snapshot.agents.find((a) => a.id === completingAgentId);
    if (!completingAgent) {
      return;
    }

    for (const peerId of roomAgentIds) {
      if (peerId === completingAgentId) {
        continue;
      }

      const peer = this.snapshot.agents.find((a) => a.id === peerId);
      if (peer && (peer.status === 'idle' || peer.status === 'waiting')) {
        const pendingCount = this.mailbox.count(peerId);
        const inboxNote = pendingCount > 0 ? ` (${pendingCount} inbox message${pendingCount > 1 ? 's' : ''})` : '';
        this.updateAgent(peerId, {
          summary: `📬 ${completingAgent.name} completed "${taskTitle}"${inboxNote}.`,
        });
      }
    }
  }
}
