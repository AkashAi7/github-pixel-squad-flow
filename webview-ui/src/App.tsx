import { useEffect, useMemo, useState } from 'react';

import type { ActivityEntry, ActivityCategory, CommandExecutionResult, HandoffPacket, ProposedFileEdit, Provider, RoomTheme, SquadAgent, TaskCard, TaskExecutionPlan, TaskStatus, WorkspaceSnapshot } from '../../src/shared/model/index.js';
import { AGENT_MOOD } from '../../src/shared/model/index.js';
import type { ExtensionMessage } from '../../src/shared/protocol/messages.js';
import { FactoryBoard } from './components/FactoryBoard.js';
import { RoomCard } from './components/RoomCard.js';
import { CreateRoomDialog } from './components/CreateRoomDialog.js';
import { SpawnAgentDialog } from './components/SpawnAgentDialog.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: (_message: unknown) => undefined };

const TASK_STATUS_ORDER: TaskStatus[] = ['active', 'queued', 'review', 'done', 'failed'];
const ACTIVITY_FILTERS: Array<ActivityCategory | 'all'> = ['all', 'task', 'agent', 'agent-chat', 'provider', 'system'];
type WorkspaceView = 'factory' | 'rooms' | 'tasks' | 'activity';

function taskProgressForStatus(status: TaskStatus) {
  switch (status) {
    case 'queued':
      return { value: 0, total: 3, label: 'Queued' };
    case 'active':
      return { value: 1, total: 3, label: 'Executing' };
    case 'review':
      return { value: 2, total: 3, label: 'Review' };
    case 'done':
      return { value: 3, total: 3, label: 'Complete' };
    case 'failed':
      return { value: 3, total: 3, label: 'Failed' };
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

function formatActivityTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function isCardActivation(event: React.KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

function activityCategoryMeta(category: ActivityCategory): { icon: string; label: string } {
  switch (category) {
    case 'task':
      return { icon: '✓', label: 'Task' };
    case 'agent':
      return { icon: '◉', label: 'Agent' };
    case 'agent-chat':
      return { icon: '…', label: 'Chat' };
    case 'provider':
      return { icon: '⚙', label: 'Provider' };
    case 'system':
    default:
      return { icon: '•', label: 'System' };
  }
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
      return [{ label: '▶ Execute', action: 'execute' }, { label: '✗ Fail', action: 'fail' }];
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
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [activeView, setActiveView] = useState<WorkspaceView>('factory');
  const [taskGroupBy, setTaskGroupBy] = useState<'status' | 'assignee' | 'room'>('status');
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [taskProviderFilter, setTaskProviderFilter] = useState<Provider | 'all'>('all');
  const [taskPersonaFilter, setTaskPersonaFilter] = useState<string | 'all'>('all');
  const [activityFilter, setActivityFilter] = useState<ActivityCategory | 'all'>('all');

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
      }

      if (event.data.type === 'taskOutput') {
        // Don't auto-expand completed tasks — avoids clutter in the panel.
        // Users can click to expand manually.
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
        <div className="loading-card">
          <p className="eyebrow">Pixel Squad</p>
          <h1>Warming the factory floor</h1>
          <p>The extension host is preparing rooms, personas, and provider health.</p>
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

  const selectedAgentFocusTask = selectedAgentTasks.find((task) => task.status === 'active')
    ?? selectedAgentTasks.find((task) => task.status === 'queued' || task.status === 'review')
    ?? selectedAgentTasks[0]
    ?? null;

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setActiveView('factory');
    vscode.postMessage({ type: 'showAgent', agentId });
  };

  return (
    <main className="shell shell--activitybar">
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
          personas={snapshot.personas}
          onSubmit={(roomId: string, name: string, personaId: string, provider: Provider, customPersona) => {
            vscode.postMessage({ type: 'spawnAgent', roomId, name, personaId, provider, customPersona });
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
            <div className="composer-actions">
              <button
                type="button"
                className="composer-button"
                disabled={isSubmitting || prompt.trim().length === 0}
                onClick={() => {
                  setIsSubmitting(true);
                  vscode.postMessage({ type: 'createTask', prompt: prompt.trim() });
                  setPrompt('');
                }}
              >
                {isSubmitting ? 'Routing...' : 'Route Task'}
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
        <div className="workspace-nav__tabs">
          <button
            type="button"
            className={`workspace-nav__tab${activeView === 'factory' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('factory')}
          >
            <span>Factory</span>
            <strong>{snapshot.agents.length}</strong>
          </button>
          <button
            type="button"
            className={`workspace-nav__tab${activeView === 'rooms' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('rooms')}
          >
            <span>Rooms</span>
            <strong>{snapshot.rooms.length}</strong>
          </button>
          <button
            type="button"
            className={`workspace-nav__tab${activeView === 'tasks' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('tasks')}
          >
            <span>Tasks</span>
            <strong>{stats.total}</strong>
          </button>
          <button
            type="button"
            className={`workspace-nav__tab${activeView === 'activity' ? ' workspace-nav__tab--active' : ''}`}
            onClick={() => setActiveView('activity')}
          >
            <span>Feed</span>
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
            onSelectAgent={handleSelectAgent}
            onSpawnAgent={(roomId) => setSpawnRoomId(roomId)}
            onDeleteRoom={(roomId) => vscode.postMessage({ type: 'deleteRoom', roomId })}
            onRemoveAgent={(agentId) => vscode.postMessage({ type: 'removeAgent', agentId })}
          />

          <aside className="column column--side column--stacked">
          {/* Inspector */}
          <section className="panel inspector-panel">
            <p className="eyebrow">Selected Agent</p>
            {selectedAgent ? (
              <>
                <h2>
                  {selectedAgent.name}
                  <span className="agent-mood-inline" title={AGENT_MOOD[selectedAgent.status].label}>
                    {AGENT_MOOD[selectedAgent.status].emoji}
                  </span>
                </h2>
                <div className="persona-pill" style={{ ['--accent' as string]: personas.get(selectedAgent.personaId)?.color ?? '#7d8cff' }}>
                  {personas.get(selectedAgent.personaId)?.title ?? selectedAgent.personaId}
                </div>
                {personas.get(selectedAgent.personaId)?.isCustom ? <div className="task-chip">Custom Agent</div> : null}
                <span className={`provider-badge provider-badge--${selectedAgent.provider}`}>
                  {selectedAgent.provider === 'copilot' ? '⚡ Copilot' : '🧠 Claude'}
                </span>
                {personas.get(selectedAgent.personaId)?.skills?.length ? (
                  <div className="skill-row">
                    {personas.get(selectedAgent.personaId)?.skills?.map((skill) => (
                      <span key={skill.id} className="skill-pill">
                        {skill.label}
                        <strong>L{skill.level}</strong>
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="inspector-copy">{selectedAgent.summary}</p>
                <dl className="facts">
                  <div><dt>Provider</dt><dd>{selectedAgent.provider}</dd></div>
                  <div><dt>Status</dt><dd><span className={`status-badge status-badge--${selectedAgent.status}`}>{selectedAgent.status}</span></dd></div>
                  <div><dt>Room</dt><dd>{snapshot.rooms.find((r) => r.id === selectedAgent.roomId)?.name}</dd></div>
                  <div><dt>Mood</dt><dd>{AGENT_MOOD[selectedAgent.status].emoji} {AGENT_MOOD[selectedAgent.status].label}</dd></div>
                </dl>
                <section className="inspector-spotlight">
                  <p className="eyebrow">Current Focus</p>
                  {selectedAgentFocusTask ? (
                    <div className="inspector-spotlight__card">
                      <div className="inspector-spotlight__meta">
                        <span className={`status-badge status-badge--${selectedAgentFocusTask.status}`}>{selectedAgentFocusTask.status}</span>
                        <span className={`provider-badge provider-badge--${selectedAgentFocusTask.provider}`}>
                          {selectedAgentFocusTask.provider === 'copilot' ? '⚡' : '🧠'} {selectedAgentFocusTask.provider}
                        </span>
                      </div>
                      <strong>{selectedAgentFocusTask.title}</strong>
                      <p>{selectedAgentFocusTask.detail}</p>
                    </div>
                  ) : (
                    <p className="inspector-copy">No active assignment. Use the task box below to give this agent work.</p>
                  )}
                </section>
                <div className="agent-controls">
                  {agentActions(selectedAgent).map(({ label, action }) => (
                    <button
                      key={action}
                      type="button"
                      className={`control-btn control-btn--${action}`}
                      onClick={() => vscode.postMessage({ type: 'agentAction', agentId: selectedAgent.id, action })}
                    >{label}</button>
                  ))}
                </div>
                <details className="inspector-section" open={selectedAgentTasks.length > 0}>
                  <summary>
                    <span>Agent Work</span>
                    <strong>{selectedAgentTasks.length}</strong>
                  </summary>
                  <div className="agent-work">
                    {selectedAgentTasks.length === 0 ? <p className="inspector-copy">No tasks assigned yet.</p> : null}
                    {selectedAgentTasks.length > 0 ? (
                      <div className="agent-work__list">
                        {selectedAgentTasks.map((task) => (
                          <article
                            key={task.id}
                            className={`agent-work__task agent-work__task--${task.status}${expandedTaskId === task.id ? ' agent-work__task--expanded' : ''}`}
                            onClick={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                            onKeyDown={(event) => {
                              if (!isCardActivation(event)) return;
                              event.preventDefault();
                              setExpandedTaskId(expandedTaskId === task.id ? null : task.id);
                            }}
                            role="button"
                            tabIndex={0}
                            aria-expanded={expandedTaskId === task.id}
                          >
                            <div className="agent-work__meta">
                              <span className={`status-badge status-badge--${task.status}`}>{task.status}</span>
                              <span className="agent-work__title">{task.title}</span>
                            </div>
                            <p className="agent-work__detail">{task.detail}</p>
                            {task.output && expandedTaskId === task.id && (
                              <div className="task-output">
                                <p className="eyebrow">Output</p>
                                <pre>{task.output}</pre>
                              </div>
                            )}
                            {expandedTaskId === task.id && planHasArtifacts(task.executionPlan) ? (
                              <div className="task-plan">
                                <p className="eyebrow">Execution Plan</p>
                                <p className="task-plan__summary">{task.executionPlan?.summary}</p>
                                {task.executionPlan?.fileEdits.length ? (
                                  <div className="task-diff-list">
                                    {task.executionPlan.fileEdits.map((edit) => (
                                      <article key={`${task.id}-${edit.filePath}`} className="task-diff-card">
                                        <div className="task-diff-card__header">
                                          <strong>{edit.action.toUpperCase()} {edit.filePath}</strong>
                                          <span>{edit.summary}</span>
                                        </div>
                                        <div className="task-diff-card__code">
                                          {buildPreviewLines(edit).map((line, index) => (
                                            <div key={`${task.id}-${edit.filePath}-${index}`} className={`task-diff-card__row task-diff-card__row--${line.kind}`}>
                                              <span className="task-diff-card__gutter">{line.before ?? ''}</span>
                                              <span className="task-diff-card__gutter">{line.after ?? ''}</span>
                                              <span className="task-diff-card__marker">{lineMarker(line.kind)}</span>
                                              <code>{line.content || ' '}</code>
                                            </div>
                                          ))}
                                        </div>
                                      </article>
                                    ))}
                                  </div>
                                ) : null}
                                {task.executionPlan?.terminalCommands.length ? <p className="task-plan__line">Commands: {task.executionPlan.terminalCommands.map((command) => command.command).join(' ; ')}</p> : null}
                                {renderCommandResults(task)}
                              </div>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>
                <details className="inspector-section">
                  <summary>
                    <span>Pinned Context Files</span>
                    <strong>{(selectedAgent.pinnedFiles ?? []).length}</strong>
                  </summary>
                  <div className="agent-pinned-files">
                  {(selectedAgent.pinnedFiles ?? []).length > 0 ? (
                    <div className="pinned-file-list">
                      {(selectedAgent.pinnedFiles ?? []).map((filePath) => (
                        <div key={filePath} className="pinned-file-item">
                          <span className="pinned-file-item__path" title={filePath}>{filePath}</span>
                          <button
                            type="button"
                            className="pinned-file-item__remove"
                            title="Unpin"
                            onClick={() => {
                              const updated = (selectedAgent.pinnedFiles ?? []).filter((f) => f !== filePath);
                              vscode.postMessage({ type: 'pinFiles', agentId: selectedAgent.id, files: updated });
                            }}
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="inspector-copy">No files pinned. Pin workspace files to give this agent extra context.</p>
                  )}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className="composer-button composer-button--ghost"
                      title="Pin the file currently open in the editor"
                      onClick={() => {
                        vscode.postMessage({ type: 'pinActiveFile', agentId: selectedAgent.id });
                      }}
                    >📎 Pin Active File</button>
                    <button
                      type="button"
                      className="composer-button composer-button--ghost"
                      onClick={() => {
                        setShowFilePicker(true);
                        setFileSearchQuery('');
                        vscode.postMessage({ type: 'requestWorkspaceFiles' });
                      }}
                    >📌 Pin Files</button>
                  </div>
                  {showFilePicker && (
                    <div className="file-picker-overlay" onClick={() => setShowFilePicker(false)}>
                      <div className="file-picker" onClick={(e) => e.stopPropagation()}>
                        <p className="eyebrow">Select files to pin to {selectedAgent.name}</p>
                        <input
                          className="file-picker__search"
                          type="text"
                          placeholder="Search files..."
                          value={fileSearchQuery}
                          onChange={(e) => setFileSearchQuery(e.target.value)}
                          autoFocus
                        />
                        <div className="file-picker__list">
                          {workspaceFiles
                            .filter((f) => !fileSearchQuery || f.toLowerCase().includes(fileSearchQuery.toLowerCase()))
                            .slice(0, 30)
                            .map((filePath) => {
                              const isPinned = (selectedAgent.pinnedFiles ?? []).includes(filePath);
                              return (
                                <button
                                  key={filePath}
                                  type="button"
                                  className={`file-picker__item${isPinned ? ' file-picker__item--pinned' : ''}`}
                                  onClick={() => {
                                    const current = selectedAgent.pinnedFiles ?? [];
                                    const updated = isPinned
                                      ? current.filter((f) => f !== filePath)
                                      : [...current, filePath];
                                    vscode.postMessage({ type: 'pinFiles', agentId: selectedAgent.id, files: updated });
                                  }}
                                >
                                  <span>{isPinned ? '📌 ' : ''}{filePath}</span>
                                </button>
                              );
                            })}
                          {workspaceFiles.length === 0 && <p className="inspector-copy">Loading workspace files...</p>}
                        </div>
                        <button
                          type="button"
                          className="composer-button"
                          onClick={() => setShowFilePicker(false)}
                        >Done</button>
                      </div>
                    </div>
                  )}
                  </div>
                </details>
                {/* Assign task to this agent */}
                <div className="assign-task">
                  <label className="composer-label" htmlFor="agent-task-prompt">Assign task to {selectedAgent.name}</label>
                  <textarea
                    id="agent-task-prompt"
                    className="assign-task__input"
                    value={agentTaskPrompt}
                    onChange={(e) => setAgentTaskPrompt(e.target.value)}
                    placeholder={`Describe a task for ${selectedAgent.name}...`}
                    rows={3}
                  />
                  <button
                    type="button"
                    className="composer-button assign-task__btn"
                    disabled={isAssigning || agentTaskPrompt.trim().length === 0}
                    onClick={() => {
                      setIsAssigning(true);
                      vscode.postMessage({ type: 'assignTask', agentId: selectedAgent.id, prompt: agentTaskPrompt.trim() });
                      setAgentTaskPrompt('');
                    }}
                  >
                    {isAssigning ? 'Assigning...' : `⚡ Assign to ${selectedAgent.name}`}
                  </button>
                </div>
              </>
            ) : (
              <p className="inspector-copy">Pick an agent from the factory floor to inspect it.</p>
            )}
          </section>
          </aside>
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
                onSelectAgent={handleSelectAgent}
              />
            ))}
          </div>
        </section>
      ) : null}

      {activeView === 'tasks' ? (
        <section className="workspace-stack">
          <aside className="column column--side column--stacked">
          <section className="panel">
            <div className="task-wall__header">
              <div>
                <p className="eyebrow">Task Wall</p>
                <p className="task-wall__copy">Group and filter the queue without losing assignee, dependency, or progress context.</p>
              </div>
              <div className="task-wall__modes">
                <button
                  type="button"
                  className={`toggle-chip${taskGroupBy === 'status' ? ' toggle-chip--active' : ''}`}
                  onClick={() => setTaskGroupBy('status')}
                >
                  By status
                </button>
                <button
                  type="button"
                  className={`toggle-chip${taskGroupBy === 'assignee' ? ' toggle-chip--active' : ''}`}
                  onClick={() => setTaskGroupBy('assignee')}
                >
                  By agent
                </button>
                <button
                  type="button"
                  className={`toggle-chip${taskGroupBy === 'room' ? ' toggle-chip--active' : ''}`}
                  onClick={() => setTaskGroupBy('room')}
                >
                  By room
                </button>
              </div>
            </div>
            <div className="task-filters">
              <label className="task-filter">
                <span>Status</span>
                <select value={taskStatusFilter} onChange={(event) => setTaskStatusFilter(event.target.value as TaskStatus | 'all')}>
                  <option value="all">All</option>
                  {TASK_STATUS_ORDER.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label className="task-filter">
                <span>Provider</span>
                <select value={taskProviderFilter} onChange={(event) => setTaskProviderFilter(event.target.value as Provider | 'all')}>
                  <option value="all">All</option>
                  <option value="copilot">Copilot</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label className="task-filter">
                <span>Persona</span>
                <select value={taskPersonaFilter} onChange={(event) => setTaskPersonaFilter(event.target.value)}>
                  <option value="all">All</option>
                  {snapshot.personas.map((persona) => (
                    <option key={persona.id} value={persona.id}>{persona.title}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="task-group-list">
              {taskGroups.length === 0 ? <p className="task-wall__empty">No tasks match the current filters.</p> : null}
              {taskGroups.map((group) => (
                <section key={group.key} className="task-group">
                  <div className="task-group__header">
                    <h3>{group.label}</h3>
                    <span>{group.tasks.length}</span>
                  </div>
                  <div className="task-list">
                    {group.tasks.map((task) => {
                      const assignee = agentsById.get(task.assigneeId);
                      const persona = assignee ? personas.get(assignee.personaId) : null;
                      const roomName = assignee ? snapshot.rooms.find((room) => room.id === assignee.roomId)?.name ?? 'No Room' : 'No Room';
                      const dependencyCount = task.dependsOn?.length ?? 0;
                      const progress = task.progress ?? taskProgressForStatus(task.status);
                      const progressWidth = `${Math.max(0, Math.min(100, (progress.value / progress.total) * 100))}%`;

                      return (
                        <article
                          key={task.id}
                          className={`task-card task-card--${task.status}${expandedTaskId === task.id ? ' task-card--expanded' : ''}`}
                          onClick={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                          onKeyDown={(event) => {
                            if (!isCardActivation(event)) return;
                            event.preventDefault();
                            setExpandedTaskId(expandedTaskId === task.id ? null : task.id);
                          }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={expandedTaskId === task.id}
                        >
                          <div className="task-meta">
                            <span className={`status-badge status-badge--${task.status}`}>{task.status}</span>
                            <span className={`provider-badge provider-badge--${task.provider}`}>
                              {task.provider === 'copilot' ? '⚡' : '🧠'} {task.provider}
                            </span>
                            <span>{task.source}</span>
                            {dependencyCount > 0 ? <span className="task-chip">Depends on {dependencyCount}</span> : null}
                            {task.approvalState ? <span className="task-chip">{task.approvalState}</span> : null}
                          </div>
                          <div className="task-card__topline">
                            <div className="task-card__headline">
                              <h3>{task.title}</h3>
                              <span className="task-card__room">{roomName}</span>
                            </div>
                            <span className="task-card__progress-chip">{progress.label}</span>
                          </div>
                          <p className="task-card__detail">{task.detail}</p>
                          <div className="task-card__footer">
                            <div className="task-card__identity">
                              <strong>{assignee?.name ?? 'Unassigned'}</strong>
                              <span>{persona?.title ?? 'Unknown persona'}</span>
                            </div>
                            <div className="task-progress" title={progress.label}>
                              <div className="task-progress__bar">
                                <div className="task-progress__fill" style={{ width: progressWidth }} />
                              </div>
                              <span>{progress.label}</span>
                            </div>
                          </div>
                          {task.output && expandedTaskId === task.id && (
                            <div className="task-output">
                              <p className="eyebrow">Execution Output</p>
                              <pre>{task.output}</pre>
                            </div>
                          )}
                          {expandedTaskId === task.id && task.workspaceContext ? (
                            <div className="task-plan">
                              <p className="eyebrow">Workspace Context</p>
                              <p className="task-plan__line">Branch: {task.workspaceContext.branch || 'unknown'}</p>
                              <p className="task-plan__line">Active file: {task.workspaceContext.activeFile || 'none'}</p>
                              {task.workspaceContext.gitStatus?.length ? <p className="task-plan__line">Git: {task.workspaceContext.gitStatus.join(' | ')}</p> : null}
                              {task.workspaceContext.relevantFiles.length ? (
                                <div className="task-plan__list">
                                  {task.workspaceContext.relevantFiles.map((file) => (
                                    <article key={file.path} className="task-plan__item">
                                      <strong>{file.path}</strong>
                                      <span>{file.reason}</span>
                                    </article>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {expandedTaskId === task.id && task.handoffPackets && task.handoffPackets.length > 0 ? (
                            <div className="task-plan">
                              <p className="eyebrow">Handoff from predecessors</p>
                              {task.handoffPackets.map((packet) => (
                                <article key={packet.fromTaskId} className="task-plan__item">
                                  <strong>From {packet.fromAgentName}</strong>
                                  <span>{packet.summary}</span>
                                  {packet.filesChanged.length > 0 ? <p className="task-plan__line">Files: {packet.filesChanged.join(', ')}</p> : null}
                                  {packet.openIssues.length > 0 ? <p className="task-plan__line">Notes: {packet.openIssues.join('; ')}</p> : null}
                                </article>
                              ))}
                            </div>
                          ) : null}
                          {expandedTaskId === task.id && planHasArtifacts(task.executionPlan) ? (
                            <div className="task-plan">
                              <p className="eyebrow">Proposed Changes</p>
                              <p className="task-plan__summary">{task.executionPlan?.summary}</p>
                              {task.executionPlan?.fileEdits.length ? (
                                <div className="task-diff-list">
                                  {task.executionPlan.fileEdits.map((edit) => (
                                    <article key={`${task.id}-${edit.filePath}`} className="task-diff-card">
                                      <div className="task-diff-card__header">
                                        <strong>{edit.action.toUpperCase()} {edit.filePath}</strong>
                                        <span>{edit.summary}</span>
                                      </div>
                                      <div className="task-diff-card__code">
                                        {buildPreviewLines(edit).map((line, index) => (
                                          <div key={`${task.id}-${edit.filePath}-${index}`} className={`task-diff-card__row task-diff-card__row--${line.kind}`}>
                                            <span className="task-diff-card__gutter">{line.before ?? ''}</span>
                                            <span className="task-diff-card__gutter">{line.after ?? ''}</span>
                                            <span className="task-diff-card__marker">{lineMarker(line.kind)}</span>
                                            <code>{line.content || ' '}</code>
                                          </div>
                                        ))}
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              ) : null}
                              {task.executionPlan?.terminalCommands.length ? (
                                <div className="task-plan__list">
                                  {task.executionPlan.terminalCommands.map((command, index) => (
                                    <article key={`${task.id}-command-${index}`} className="task-plan__item">
                                      <strong>{command.command}</strong>
                                      <span>{command.summary}</span>
                                    </article>
                                  ))}
                                </div>
                              ) : null}
                              {renderCommandResults(task)}
                              {task.executionPlan?.tests.length ? <p className="task-plan__line">Tests: {task.executionPlan.tests.join(' | ')}</p> : null}
                              {task.executionPlan?.notes.length ? <p className="task-plan__line">Notes: {task.executionPlan.notes.join(' | ')}</p> : null}
                            </div>
                          ) : null}
                          <div className="task-controls" onClick={(e) => e.stopPropagation()}>
                            {taskActions(task).map(({ label, action }) => (
                              <button
                                key={action}
                                type="button"
                                className={`control-btn control-btn--${action}`}
                                onClick={() => vscode.postMessage({ type: 'taskAction', taskId: task.id, action })}
                              >{label}</button>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </section>
          </aside>
        </section>
      ) : null}

      {activeView === 'activity' ? (
        <section className="workspace-stack">
          <aside className="column column--side column--stacked">
          <section className="panel">
            <div className="task-wall__header">
              <div>
                <p className="eyebrow">Activity Feed</p>
                <p className="task-wall__copy">Structured events are now grouped by category so provider chatter and task flow are easier to scan.</p>
              </div>
              <label className="task-filter task-filter--compact">
                <span>Filter</span>
                <select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value as ActivityCategory | 'all')}>
                  {ACTIVITY_FILTERS.map((filter) => (
                    <option key={filter} value={filter}>{filter}</option>
                  ))}
                </select>
              </label>
            </div>
            <ul className="activity-feed">
              {filteredActivity.length === 0 ? <li className="activity-feed__empty">No activity matches the current filter.</li> : null}
              {filteredActivity.map((item) => {
                const meta = activityCategoryMeta(item.category);
                return (
                  <li key={item.id} className={`activity-feed__item activity-feed__item--${item.category}`}>
                    <div className="activity-feed__meta">
                      <div className="activity-feed__meta-main">
                        <span className={`activity-badge activity-badge--${item.category}`}>{meta.icon} {meta.label}</span>
                        <span className="activity-feed__verb">{item.category.replace('-', ' ')}</span>
                      </div>
                      <time>{formatActivityTime(item.timestamp)}</time>
                    </div>
                    <p>{item.message}</p>
                  </li>
                );
              })}
            </ul>
          </section>
          </aside>
        </section>
      ) : null}
    </main>
  );
}

export default App;
