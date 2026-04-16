import { useEffect, useMemo, useState } from 'react';

import type { ActivityEntry, ActivityCategory, CommandExecutionResult, HandoffPacket, ProposedFileEdit, Provider, RoomTheme, SquadAgent, TaskCard, TaskExecutionPlan, TaskStatus, WorkspaceSnapshot } from '../../src/shared/model/index.js';
import { AGENT_MOOD } from '../../src/shared/model/index.js';
import type { ExtensionMessage } from '../../src/shared/protocol/messages.js';
import { FactoryBoard } from './components/FactoryBoard.js';
import { RoomCard } from './components/RoomCard.js';
import { CreateRoomDialog } from './components/CreateRoomDialog.js';
import { SpawnAgentDialog } from './components/SpawnAgentDialog.js';
import { TaskCardComponent } from './components/TaskCardComponent.js';
import { ActivityFeedComponent, ACTIVITY_FILTERS } from './components/ActivityFeedComponent.js';
import { ProvidersViewComponent } from './components/ProvidersViewComponent.js';
import { InspectorPanelComponent } from './components/InspectorPanelComponent.js';
import { TaskWallComponent, TASK_STATUS_ORDER } from './components/TaskWallComponent.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: (_message: unknown) => undefined };
type WorkspaceView = 'factory' | 'rooms' | 'tasks' | 'providers' | 'activity';
const WORKSPACE_VIEWS: WorkspaceView[] = ['factory', 'rooms', 'tasks', 'providers', 'activity'];

function taskProgressForStatus(status: TaskStatus) {
  switch (status) {
    case 'queued':
      return { value: 1, total: 5, label: 'Queued' };
    case 'active':
      return { value: 2, total: 5, label: 'Executing' };
    case 'review':
      return { value: 4, total: 5, label: 'Review' };
    case 'done':
      return { value: 5, total: 5, label: 'Complete' };
    case 'failed':
      return { value: 5, total: 5, label: 'Failed' };
  }
}

function normalizeActivityEntry(entry: ActivityEntry | string, index: number): ActivityEntry {
  if (typeof entry === 'string') {
    return {
      id: `legacy-activity-${index}`,
      category: 'system',
      message: entry,
      timestamp: Date.now() - index,
    };
  }

  return {
    ...entry,
    id: entry.id ?? `activity-${Date.now()}-${index}`,
    category: entry.category ?? 'system',
    timestamp: entry.timestamp ?? Date.now() - index,
  };
}

function normalizeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((task) => ({
      ...task,
      dependsOn: task.dependsOn ?? [],
      requiredSkillIds: task.requiredSkillIds ?? [],
      progress: task.progress ?? taskProgressForStatus(task.status),
    })),
    activityFeed: (snapshot.activityFeed as Array<ActivityEntry | string>).map((entry, index) => normalizeActivityEntry(entry, index)),
  };
}

function pickFocusTask(tasks: TaskCard[], agentId: string): TaskCard | null {
  const agentTasks = tasks.filter((task) => task.assigneeId === agentId);
  return agentTasks.find((task) => task.status === 'active')
    ?? agentTasks.find((task) => task.status === 'queued' || task.status === 'review')
    ?? agentTasks[0]
    ?? null;
}

function isCardActivation(event: React.KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

function agentActions(agent: SquadAgent): Array<{ label: string; action: string }> {
  switch (agent.status) {
    case 'executing':
    case 'planning':
      return [{ label: '⏸ Pause', action: 'pause' }, { label: '✓ Complete', action: 'complete' }];
    case 'paused':
      return [{ label: '▶ Resume', action: 'resume' }, { label: '✓ Complete', action: 'complete' }];
    case 'failed':
    case 'blocked':
      return [{ label: '↻ Retry', action: 'retry' }];
    case 'waiting':
      return [{ label: '✓ Complete', action: 'complete' }];
    default:
      return [];
  }
}

function taskActions(task: TaskCard): Array<{ label: string; action: string }> {
  switch (task.status) {
    case 'queued':
      return [{ label: '▶ Execute', action: 'execute' }];
    case 'active':
      return [{ label: '✗ Fail', action: 'fail' }];
    case 'review':
      return [
        { label: '✓ Approve', action: 'complete' },
        ...(task.executionPlan?.terminalCommands.length ? [{ label: task.executionPlan.commandResults.some((result) => result.status !== 'pending') ? '↻ Re-run Commands' : '⌘ Run Commands', action: 'run' }] : []),
        { label: '✗ Reject', action: 'fail' },
      ];
    case 'failed':
      return [{ label: '↻ Retry', action: 'retry' }];
    case 'done':
      return [{ label: '↻ Re-open', action: 'retry' }];
    default:
      return [];
  }
}

function planHasArtifacts(plan: TaskExecutionPlan | undefined): boolean {
  return Boolean(plan && (plan.fileEdits.length > 0 || plan.terminalCommands.length > 0 || plan.tests.length > 0 || plan.notes.length > 0));
}

type DiffPreviewLine = {
  kind: 'context' | 'add' | 'remove';
  before?: number;
  after?: number;
  content: string;
};

function buildPreviewLines(edit: ProposedFileEdit, contextWindow = 3, maxCreateLines = 40): DiffPreviewLine[] {
  const splitLines = (value: string | undefined) => (value ?? '').replace(/\r/g, '').split('\n');
  const proposedLines = splitLines(edit.content);

  if (edit.action === 'create' || edit.originalContent === undefined) {
    return proposedLines.slice(0, maxCreateLines).map((content, index) => ({
      kind: 'add',
      after: index + 1,
      content,
    }));
  }

  const originalLines = splitLines(edit.originalContent);
  let prefix = 0;
  while (prefix < originalLines.length && prefix < proposedLines.length && originalLines[prefix] === proposedLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < proposedLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] === proposedLines[proposedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === originalLines.length && prefix === proposedLines.length) {
    return originalLines.slice(0, Math.min(originalLines.length, contextWindow * 2)).map((content, index) => ({
      kind: 'context',
      before: index + 1,
      after: index + 1,
      content,
    }));
  }

  const previewLines: DiffPreviewLine[] = [];
  const sharedStart = Math.max(0, prefix - contextWindow);
  for (let index = sharedStart; index < prefix; index += 1) {
    previewLines.push({
      kind: 'context',
      before: index + 1,
      after: index + 1,
      content: originalLines[index],
    });
  }

  const originalChangedEnd = Math.max(prefix, originalLines.length - suffix);
  for (let index = prefix; index < originalChangedEnd; index += 1) {
    previewLines.push({
      kind: 'remove',
      before: index + 1,
      content: originalLines[index],
    });
  }

  const proposedChangedEnd = Math.max(prefix, proposedLines.length - suffix);
  for (let index = prefix; index < proposedChangedEnd; index += 1) {
    previewLines.push({
      kind: 'add',
      after: index + 1,
      content: proposedLines[index],
    });
  }

  const trailingCount = Math.min(contextWindow, suffix);
  const originalTrailingStart = originalLines.length - trailingCount;
  const proposedTrailingStart = proposedLines.length - trailingCount;
  for (let index = 0; index < trailingCount; index += 1) {
    previewLines.push({
      kind: 'context',
      before: originalTrailingStart + index + 1,
      after: proposedTrailingStart + index + 1,
      content: originalLines[originalTrailingStart + index],
    });
  }

  return previewLines;
}

function lineMarker(kind: DiffPreviewLine['kind']): string {
  if (kind === 'add') {
    return '+';
  }
  if (kind === 'remove') {
    return '-';
  }
  return ' ';
}

function commandResultLabel(result: CommandExecutionResult): string {
  if (result.status === 'succeeded') {
    return `Succeeded${typeof result.exitCode === 'number' ? ` (exit ${result.exitCode})` : ''}`;
  }
  if (result.status === 'failed') {
    return `Failed${typeof result.exitCode === 'number' ? ` (exit ${result.exitCode})` : ''}`;
  }
  if (result.status === 'running') {
    return 'Running';
  }
  return 'Pending';
}

function renderCommandResults(task: TaskCard) {
  const results = task.executionPlan?.commandResults ?? [];
  if (!results.length) {
    return null;
  }

  return (
    <div className="task-plan__list">
      {results.map((result) => (
        <article key={`${task.id}-command-result-${result.commandIndex}`} className={`task-command-result task-command-result--${result.status}`}>
          <div className="task-command-result__header">
            <strong>{result.command}</strong>
            <span className={`task-command-result__status task-command-result__status--${result.status}`}>{commandResultLabel(result)}</span>
          </div>
          <span>{result.summary}</span>
          {typeof result.durationMs === 'number' ? <p className="task-plan__line">Duration: {result.durationMs} ms</p> : null}
          {result.stdout ? (
            <div className="task-output task-output--compact">
              <p className="eyebrow">stdout</p>
              <pre>{result.stdout}</pre>
            </div>
          ) : null}
          {result.stderr ? (
            <div className="task-output task-output--compact">
              <p className="eyebrow">stderr</p>
              <pre>{result.stderr}</pre>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [spawnRoomId, setSpawnRoomId] = useState<string | null>(null);
  const [agentTaskPrompt, setAgentTaskPrompt] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'overview' | 'assign' | 'work'>('overview');
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [activeView, setActiveView] = useState<WorkspaceView>('factory');
  const [taskGroupBy, setTaskGroupBy] = useState<'status' | 'assignee' | 'room'>('status');
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [taskProviderFilter, setTaskProviderFilter] = useState<Provider | 'all'>('all');
  const [taskPersonaFilter, setTaskPersonaFilter] = useState<string | 'all'>('all');
  const [activityFilter, setActivityFilter] = useState<ActivityCategory | 'all'>('all');
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: 'info' | 'success' | 'error' }>>([]);
  const [showFirstRun, setShowFirstRun] = useState(true);
  const [streamingOutputs, setStreamingOutputs] = useState<Record<string, string>>({});

  const addToast = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  };

  const handleWorkspaceNavKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = WORKSPACE_VIEWS.indexOf(activeView);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = (currentIndex + 1) % WORKSPACE_VIEWS.length;
      setActiveView(WORKSPACE_VIEWS[nextIndex]);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const prevIndex = (currentIndex - 1 + WORKSPACE_VIEWS.length) % WORKSPACE_VIEWS.length;
      setActiveView(WORKSPACE_VIEWS[prevIndex]);
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
      if (event.data.type === 'bootstrapState') {
        const nextSnapshot = normalizeSnapshot(event.data.snapshot);
        setSnapshot(nextSnapshot);
        setActivity(nextSnapshot.activityFeed);
        setSelectedAgentId((prev) => prev ?? nextSnapshot.agents[0]?.id ?? null);
        setIsSubmitting(false);
        setIsAssigning(false);
      }

      if (event.data.type === 'assignAck') {
        setIsAssigning(false);
      }

      if (event.data.type === 'activity') {
        const nextActivity = normalizeActivityEntry(event.data.activity ?? event.data.message, 0);
        setActivity((current) => [nextActivity, ...current].slice(0, 20));
        // Surface important background events as toasts
        const cat = nextActivity.category;
        if (cat === 'task') {
          const msg = nextActivity.message;
          if (msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('error')) {
            addToast(msg, 'error');
          } else if (msg.toLowerCase().includes('complete') || msg.toLowerCase().includes('done')) {
            addToast(msg, 'success');
          }
        } else if (cat === 'provider' && nextActivity.message.toLowerCase().includes('unavailable')) {
          addToast(nextActivity.message, 'error');
        }
      }

      if (event.data.type === 'taskOutput') {
        // Don't auto-expand completed tasks — avoids clutter in the panel.
        // Users can click to expand manually.
      }

      if (event.data.type === 'taskChunk') {
        const { taskId, chunk } = event.data;
        setStreamingOutputs((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? '') + chunk }));
      }

      if (event.data.type === 'bootstrapState') {
        // Clear streaming buffers for tasks that have now settled (done/failed/review).
        setStreamingOutputs((prev) => {
          const next = { ...prev };
          for (const task of (event.data.snapshot?.tasks ?? [])) {
            if (task.status !== 'active') { delete next[task.id]; }
          }
          return next;
        });
      }

      if (event.data.type === 'workspaceFiles') {
        setWorkspaceFiles(event.data.files);
      }

      if (event.data.type === 'agentChat') {
        // Agent-to-agent messages are also logged via activity feed ('agent-chat' category).
        // This handler can be extended for a dedicated chat panel in the future.
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'webviewReady' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const selectedAgent = useMemo<SquadAgent | null>(() => {
    if (!snapshot || !selectedAgentId) return null;
    return snapshot.agents.find((a) => a.id === selectedAgentId) ?? null;
  }, [selectedAgentId, snapshot]);

  const personas = useMemo(
    () => new Map(snapshot?.personas.map((p) => [p.id, p]) ?? []),
    [snapshot],
  );

  const spawnRoom = useMemo(
    () => snapshot?.rooms.find((r) => r.id === spawnRoomId) ?? null,
    [spawnRoomId, snapshot],
  );

  const agentsById = useMemo(
    () => new Map(snapshot?.agents.map((agent) => [agent.id, agent]) ?? []),
    [snapshot],
  );

  const filteredTasks = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.tasks.filter((task) => {
      const assignee = agentsById.get(task.assigneeId);
      const personaId = assignee?.personaId ?? 'unknown';
      const statusMatch = taskStatusFilter === 'all' || task.status === taskStatusFilter;
      const providerMatch = taskProviderFilter === 'all' || task.provider === taskProviderFilter;
      const personaMatch = taskPersonaFilter === 'all' || personaId === taskPersonaFilter;
      return statusMatch && providerMatch && personaMatch;
    });
  }, [agentsById, snapshot, taskPersonaFilter, taskProviderFilter, taskStatusFilter]);

  const taskGroups = useMemo(() => {
    if (!snapshot) return [] as Array<{ key: string; label: string; tasks: TaskCard[] }>;

    if (taskGroupBy === 'assignee') {
      const groups = new Map<string, { label: string; tasks: TaskCard[] }>();
      for (const task of filteredTasks) {
        const assignee = agentsById.get(task.assigneeId);
        const key = assignee?.id ?? 'unassigned';
        const existing = groups.get(key);
        const label = assignee?.name ?? 'Unassigned';
        if (existing) {
          existing.tasks.push(task);
        } else {
          groups.set(key, { label, tasks: [task] });
        }
      }

      return Array.from(groups.entries()).map(([key, value]) => ({ key, label: value.label, tasks: value.tasks }));
    }

    if (taskGroupBy === 'room') {
      const groups = new Map<string, { label: string; tasks: TaskCard[] }>();
      for (const task of filteredTasks) {
        const assignee = agentsById.get(task.assigneeId);
        const room = assignee ? snapshot.rooms.find((r) => r.id === assignee.roomId) : undefined;
        const key = room?.id ?? 'no-room';
        const existing = groups.get(key);
        const label = room?.name ?? 'No Room';
        if (existing) {
          existing.tasks.push(task);
        } else {
          groups.set(key, { label, tasks: [task] });
        }
      }

      return Array.from(groups.entries()).map(([key, value]) => ({ key, label: value.label, tasks: value.tasks }));
    }

    return TASK_STATUS_ORDER
      .map((status) => ({
        key: status,
        label: status === 'done' ? 'Done' : status === 'active' ? 'Active' : status[0].toUpperCase() + status.slice(1),
        tasks: filteredTasks.filter((task) => task.status === status),
      }))
      .filter((group) => group.tasks.length > 0);
  }, [agentsById, filteredTasks, snapshot, taskGroupBy]);

  const filteredActivity = useMemo(() => {
    return activity.filter((entry) => activityFilter === 'all' || entry.category === activityFilter);
  }, [activity, activityFilter]);

  if (!snapshot) {
    return (
      <main className="shell shell--loading">
        <div className="loading-card" role="status" aria-busy="true" aria-label="Loading Pixel Squad">
          <p className="eyebrow">Pixel Squad</p>
          <h1>Warming the factory floor</h1>
          <p>The extension host is preparing rooms, personas, and provider health.</p>
          <div className="loading-card__spinner" aria-hidden="true">
            <span className="inline-spinner" style={{ width: 20, height: 20 }} />
          </div>
        </div>
      </main>
    );
  }

  const stats = {
    total: snapshot.tasks.length,
    active: snapshot.tasks.filter((t) => t.status === 'active').length,
    done: snapshot.tasks.filter((t) => t.status === 'done').length,
    failed: snapshot.tasks.filter((t) => t.status === 'failed').length,
    copilot: snapshot.agents.filter((a) => a.provider === 'copilot').length,
    claude: snapshot.agents.filter((a) => a.provider === 'claude').length,
  };

  const selectedAgentTasks = selectedAgent
    ? snapshot.tasks.filter((task) => task.assigneeId === selectedAgent.id)
    : [];

  const selectedAgentFocusTask = selectedAgent ? pickFocusTask(snapshot.tasks, selectedAgent.id) : null;

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setActiveView('factory');
    setInspectorTab('overview');
    vscode.postMessage({ type: 'showAgent', agentId });
  };

  const handleRevealAgentTask = (agentId: string) => {
    setSelectedAgentId(agentId);
    setTaskStatusFilter('all');
    setTaskProviderFilter('all');
    setTaskPersonaFilter('all');

    const focusTask = pickFocusTask(snapshot.tasks, agentId);
    if (focusTask) {
      setExpandedTaskId(focusTask.id);
      setInspectorTab('work');
      setActiveView('tasks');
    } else {
      setExpandedTaskId(null);
      setInspectorTab('overview');
      setActiveView('factory');
    }

    vscode.postMessage({ type: 'showAgent', agentId });
  };

  return (
    <main className="shell shell--activitybar">
      {/* ─── Toast container ─── */}
      {toasts.length > 0 && (
        <div className="toast-container" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast--${t.type}`}>{t.message}</div>
          ))}
        </div>
      )}

      {/* ─── Dialogs ─── */}
      {showCreateRoom && (
        <CreateRoomDialog
          onSubmit={(name: string, theme: RoomTheme, purpose: string) => {
            vscode.postMessage({ type: 'createRoom', name, theme, purpose });
            setShowCreateRoom(false);
          }}
          onCancel={() => setShowCreateRoom(false)}
        />
      )}
      {spawnRoom && (
        <SpawnAgentDialog
          roomName={spawnRoom.name}
          roomId={spawnRoom.id}
          roomTasks={snapshot.tasks.filter((task) => task.status === 'queued' && agentsById.get(task.assigneeId)?.roomId === spawnRoom.id)}
          personas={snapshot.personas}
          onSubmit={(roomId: string, name: string, personaId: string, provider: Provider, customPersona, assignTaskId) => {
            vscode.postMessage({ type: 'spawnAgent', roomId, name, personaId, provider, customPersona, assignTaskId });
            setSpawnRoomId(null);
          }}
          onCancel={() => setSpawnRoomId(null)}
        />
      )}

      {/* ─── Hero ─── */}
      <section className="hero-panel hero-panel--activitybar">
        <div className="hero-panel__header">
          <div className="hero-panel__titleblock">
            <p className="eyebrow">Agent Factory · Copilot + Claude</p>
            <h1>{snapshot.projectName}</h1>
            <p className="hero-copy">
              Route work, inspect agents, and steer the squad from a tighter activity-bar control surface.
            </p>
          </div>
          <div className="hero-panel__summary">
            <span className="hero-summary-pill">{snapshot.rooms.length} rooms</span>
            <span className="hero-summary-pill">{snapshot.agents.length} agents</span>
            <span className="hero-summary-pill">{stats.active} running</span>
          </div>
        </div>
        <div className="hero-panel__body">
          {/* ─── First Run Banner ─── */}
          {showFirstRun && snapshot.rooms.length === 0 && snapshot.agents.length === 0 && (
            <div className="first-run-banner">
              <div className="first-run-banner__header">
                <span className="first-run-banner__title">Welcome to Pixel Squad</span>
                <button
                  type="button"
                  className="first-run-banner__dismiss"
                  aria-label="Dismiss welcome banner"
                  onClick={() => setShowFirstRun(false)}
                >✕</button>
              </div>
              <ol className="first-run-banner__steps">
                <li className="first-run-banner__step">
                  <span className="first-run-banner__step-num">1</span>
                  <span>Create a <strong>Room</strong> — a logical workspace for a team of agents (e.g. "Frontend", "API").</span>
                </li>
                <li className="first-run-banner__step">
                  <span className="first-run-banner__step-num">2</span>
                  <span>Spawn an <strong>Agent</strong> inside the room — choose a persona and provider (GitHub Copilot or Claude).</span>
                </li>
                <li className="first-run-banner__step">
                  <span className="first-run-banner__step-num">3</span>
                  <span><strong>Route a task</strong> — describe any goal in the box below and press Route Task.</span>
                </li>
              </ol>
            </div>
          )}
          <div className="stats-bar">
            <span className="stat">{stats.total} tasks</span>
            <span className="stat stat--active">{stats.active} active</span>
            <span className="stat stat--done">{stats.done} done</span>
            {stats.failed > 0 && <span className="stat stat--failed">{stats.failed} failed</span>}
            <span className="stat stat--copilot">⚡ {stats.copilot} copilot</span>
            <span className="stat stat--claude">🧠 {stats.claude} claude</span>
            <button
              type="button"
              className={`stat-toggle${snapshot.settings.autoExecute ? ' stat-toggle--on' : ''}`}
              onClick={() => vscode.postMessage({ type: 'toggleAutoExecute' })}
              title="Toggle automatic task execution and auto-apply behavior"
            >
              Auto-execute: {snapshot.settings.autoExecute ? 'On' : 'Off'}
            </button>
          </div>
          <div className="provider-strip provider-strip--compact">
            {snapshot.providers.map((provider) => (
              <article key={provider.provider} className={`provider-chip provider-chip--compact provider-chip--${provider.state}`}>
                <span className="provider-chip__icon">
                  {provider.provider === 'copilot' ? '⚡' : '🧠'}
                </span>
                <div className="provider-chip__content">
                  <strong>{provider.provider}</strong>
                  <p>{provider.detail}</p>
                </div>
                <span className="provider-chip__state">{provider.state}</span>
              </article>
            ))}
          </div>
          <div className="task-composer">
            <label className="composer-label" htmlFor="task-prompt">Route a new task</label>
            <textarea
              id="task-prompt"
              className="composer-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Build a settings screen, persist preferences, and add a validation pass."
            />
            <div className="composer-agent-row">
              <label className="composer-agent-label" htmlFor="composer-agent-select">Quick-assign to:</label>
              <select
                id="composer-agent-select"
                className="composer-agent-select"
                value={selectedAgentId ?? ''}
                onChange={(e) => setSelectedAgentId(e.target.value || null)}
              >
                <option value="">— auto-route —</option>
                {snapshot.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({personas.get(agent.personaId)?.title ?? agent.personaId}) · {agent.status}
                  </option>
                ))}
              </select>
            </div>
            <div className="composer-actions">
              <button
                type="button"
                className={`composer-button${isSubmitting ? ' composer-button--loading' : ''}`}
                disabled={isSubmitting || prompt.trim().length === 0}
                onClick={() => {
                  setIsSubmitting(true);
                  if (selectedAgentId) {
                    vscode.postMessage({ type: 'assignTask', agentId: selectedAgentId, prompt: prompt.trim() });
                  } else {
                    vscode.postMessage({ type: 'createTask', prompt: prompt.trim() });
                  }
                  setPrompt('');
                }}
                aria-busy={isSubmitting}
              >
                {isSubmitting ? <><span className="inline-spinner" aria-hidden="true" />Routing...</> : selectedAgentId ? `⚡ Assign to ${snapshot.agents.find(a => a.id === selectedAgentId)?.name ?? 'Agent'}` : 'Route Task'}
              </button>
              <button
                type="button"
                className={`composer-button composer-button--fleet${isSubmitting ? ' composer-button--loading' : ''}`}
                disabled={isSubmitting || prompt.trim().length === 0}
                title="Fleet mode: execute across all idle agents in parallel"
                onClick={() => {
                  setIsSubmitting(true);
                  vscode.postMessage({ type: 'fleetExecute', prompt: prompt.trim() });
                  setPrompt('');
                }}
                aria-busy={isSubmitting}
              >
                {isSubmitting ? <><span className="inline-spinner" aria-hidden="true" />Launching...</> : '🚀 Fleet'}
              </button>
              <button
                type="button"
                className="composer-button composer-button--accent"
                onClick={() => setShowCreateRoom(true)}
              >
                + Room
              </button>
              <button
                type="button"
                className="composer-button composer-button--ghost"
                onClick={() => {
                  setPrompt('');
                  vscode.postMessage({ type: 'resetWorkspace' });
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="workspace-nav panel">
        <div className="workspace-nav__header">
          <p className="eyebrow">Workspace Views</p>
          <span className="workspace-nav__hint">Factory control, roster, queue, and feed.</span>
        </div>
        <div className="workspace-nav__tabs" role="tablist" onKeyDown={handleWorkspaceNavKeyDown}>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'factory'}
            tabIndex={activeView === 'factory' ? 0 : -1}
            className={`workspace-nav__tab${activeView === 'factory' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('factory')}
          >
            <span>Agent Factory</span>
            <strong>{snapshot.agents.length}</strong>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'rooms'}
            tabIndex={activeView === 'rooms' ? 0 : -1}
            className={`workspace-nav__tab${activeView === 'rooms' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('rooms')}
          >
            <span>Rooms</span>
            <strong>{snapshot.rooms.length}</strong>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'tasks'}
            tabIndex={activeView === 'tasks' ? 0 : -1}
            className={`workspace-nav__tab${activeView === 'tasks' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('tasks')}
          >
            <span>Tasks</span>
            <strong>{stats.total}</strong>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'providers'}
            tabIndex={activeView === 'providers' ? 0 : -1}
            className={`workspace-nav__tab${activeView === 'providers' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('providers')}
          >
            <span>Providers</span>
            <strong>{snapshot.providers.length}</strong>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'activity'}
            tabIndex={activeView === 'activity' ? 0 : -1}
            className={`workspace-nav__tab${activeView === 'activity' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('activity')}
          >
            <span>Activity Feed</span>
            <strong>{filteredActivity.length}</strong>
          </button>
        </div>
      </section>

      {activeView === 'factory' ? (
        <section className="workspace-stack">
          <FactoryBoard
            rooms={snapshot.rooms}
            agents={snapshot.agents}
            personas={snapshot.personas}
            tasks={snapshot.tasks}
            selectedAgentId={selectedAgentId}
            onSelectAgent={handleRevealAgentTask}
            onSpawnAgent={(roomId) => setSpawnRoomId(roomId)}
            onDeleteRoom={(roomId) => vscode.postMessage({ type: 'deleteRoom', roomId })}
            onRemoveAgent={(agentId) => vscode.postMessage({ type: 'removeAgent', agentId })}
          />

          <InspectorPanelComponent
            selectedAgent={selectedAgent}
            selectedAgentTasks={selectedAgentTasks}
            selectedAgentFocusTask={selectedAgentFocusTask}
            personas={personas}
            rooms={snapshot.rooms}
            inspectorTab={inspectorTab}
            setInspectorTab={setInspectorTab}
            agentTaskPrompt={agentTaskPrompt}
            setAgentTaskPrompt={setAgentTaskPrompt}
            isAssigning={isAssigning}
            setIsAssigning={setIsAssigning}
            expandedTaskId={expandedTaskId}
            setExpandedTaskId={setExpandedTaskId}
            showFilePicker={showFilePicker}
            setShowFilePicker={setShowFilePicker}
            fileSearchQuery={fileSearchQuery}
            setFileSearchQuery={setFileSearchQuery}
            workspaceFiles={workspaceFiles}
            streamingOutputs={streamingOutputs}
            vscode={vscode}
          />
        </section>
      ) : null}

      {activeView === 'rooms' ? (
        <section className="workspace-stack">
          <div className="column column--rooms column--stacked">
            {snapshot.rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                agents={snapshot.agents.filter((a) => a.roomId === room.id)}
                personas={snapshot.personas}
                selectedAgentId={selectedAgentId}
                onSelectAgent={handleRevealAgentTask}
              />
            ))}
          </div>
        </section>
      ) : null}

      {activeView === 'tasks' ? (
        <TaskWallComponent
          taskGroupBy={taskGroupBy}
          setTaskGroupBy={setTaskGroupBy}
          taskStatusFilter={taskStatusFilter}
          setTaskStatusFilter={setTaskStatusFilter}
          taskProviderFilter={taskProviderFilter}
          setTaskProviderFilter={setTaskProviderFilter}
          taskPersonaFilter={taskPersonaFilter}
          setTaskPersonaFilter={setTaskPersonaFilter}
          taskGroups={taskGroups}
          agentsById={agentsById}
          personas={snapshot.personas}
          rooms={snapshot.rooms}
          expandedTaskId={expandedTaskId}
          setExpandedTaskId={setExpandedTaskId}
          streamingOutputs={streamingOutputs}
          allTasks={snapshot.tasks}
          vscode={vscode}
        />
      ) : null}

      {activeView === 'providers' ? (
        <ProvidersViewComponent
          providers={snapshot.providers}
          stats={stats}
          totalAgents={snapshot.agents.length}
        />
      ) : null}

      {activeView === 'activity' ? (
        <ActivityFeedComponent
          filteredActivity={filteredActivity}
          activityFilter={activityFilter}
          setActivityFilter={setActivityFilter}
        />
      ) : null}
    </main>
  );
}

export default App;
