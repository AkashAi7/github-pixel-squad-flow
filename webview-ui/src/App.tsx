import { useEffect, useMemo, useState } from 'react';

import type { WorkspaceSnapshot, SquadAgent, TaskCard, Provider, RoomTheme } from '../../src/shared/model/index.js';
import type { ExtensionMessage } from '../../src/shared/protocol/messages.js';
import { FactoryBoard } from './components/FactoryBoard.js';
import { RoomCard } from './components/RoomCard.js';
import { CreateRoomDialog } from './components/CreateRoomDialog.js';
import { SpawnAgentDialog } from './components/SpawnAgentDialog.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: (_message: unknown) => undefined };

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
      return [{ label: '✓ Approve', action: 'complete' }, { label: '✗ Reject', action: 'fail' }];
    case 'failed':
      return [{ label: '↻ Retry', action: 'retry' }];
    case 'done':
      return [{ label: '↻ Re-open', action: 'retry' }];
    default:
      return [];
  }
}

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [activity, setActivity] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [spawnRoomId, setSpawnRoomId] = useState<string | null>(null);
  const [agentTaskPrompt, setAgentTaskPrompt] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
      if (event.data.type === 'bootstrapState') {
        setSnapshot(event.data.snapshot);
        setActivity(event.data.snapshot.activityFeed);
        setSelectedAgentId((prev) => prev ?? event.data.snapshot.agents[0]?.id ?? null);
        setIsSubmitting(false);
        setIsAssigning(false);
      }

      if (event.data.type === 'activity') {
        setActivity((current) => [event.data.message, ...current].slice(0, 20));
      }

      if (event.data.type === 'taskOutput') {
        setExpandedTaskId(event.data.taskId);
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

  return (
    <main className="shell">
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
          onSubmit={(roomId: string, name: string, personaId: string, provider: Provider) => {
            vscode.postMessage({ type: 'spawnAgent', roomId, name, personaId, provider });
            setSpawnRoomId(null);
          }}
          onCancel={() => setSpawnRoomId(null)}
        />
      )}

      {/* ─── Hero ─── */}
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Agent Factory · Copilot + Claude</p>
          <h1>{snapshot.projectName}</h1>
          <p className="hero-copy">
            Create rooms, spawn pixel agents, and orchestrate your squad across
            GitHub Copilot and Claude — all inside VS Code.
          </p>
          <div className="stats-bar">
            <span className="stat">{stats.total} tasks</span>
            <span className="stat stat--active">{stats.active} active</span>
            <span className="stat stat--done">{stats.done} done</span>
            {stats.failed > 0 && <span className="stat stat--failed">{stats.failed} failed</span>}
            <span className="stat stat--copilot">⚡ {stats.copilot} copilot</span>
            <span className="stat stat--claude">🧠 {stats.claude} claude</span>
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
        <div className="provider-strip">
          {snapshot.providers.map((provider) => (
            <article key={provider.provider} className={`provider-chip provider-chip--${provider.state}`}>
              <span className="provider-chip__icon">
                {provider.provider === 'copilot' ? '⚡' : '🧠'}
              </span>
              <span>{provider.provider}</span>
              <strong>{provider.state}</strong>
              <p>{provider.detail}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ─── Factory Board ─── */}
      <FactoryBoard
        rooms={snapshot.rooms}
        agents={snapshot.agents}
        personas={snapshot.personas}
        selectedAgentId={selectedAgentId}
        onSelectAgent={(agentId) => {
          setSelectedAgentId(agentId);
          vscode.postMessage({ type: 'showAgent', agentId });
        }}
        onSpawnAgent={(roomId) => setSpawnRoomId(roomId)}
        onDeleteRoom={(roomId) => vscode.postMessage({ type: 'deleteRoom', roomId })}
        onRemoveAgent={(agentId) => vscode.postMessage({ type: 'removeAgent', agentId })}
      />

      {/* ─── Detail Columns ─── */}
      <section className="layout">
        <div className="column column--rooms">
          {snapshot.rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              agents={snapshot.agents.filter((a) => a.roomId === room.id)}
              personas={snapshot.personas}
              selectedAgentId={selectedAgentId}
              onSelectAgent={(agentId) => {
                setSelectedAgentId(agentId);
                vscode.postMessage({ type: 'showAgent', agentId });
              }}
            />
          ))}
        </div>

        <aside className="column column--side">
          {/* Inspector */}
          <section className="panel inspector-panel">
            <p className="eyebrow">Selected Agent</p>
            {selectedAgent ? (
              <>
                <h2>{selectedAgent.name}</h2>
                <div className="persona-pill" style={{ ['--accent' as string]: personas.get(selectedAgent.personaId)?.color ?? '#7d8cff' }}>
                  {personas.get(selectedAgent.personaId)?.title ?? selectedAgent.personaId}
                </div>
                <span className={`provider-badge provider-badge--${selectedAgent.provider}`}>
                  {selectedAgent.provider === 'copilot' ? '⚡ Copilot' : '🧠 Claude'}
                </span>
                <p className="inspector-copy">{selectedAgent.summary}</p>
                <dl className="facts">
                  <div><dt>Provider</dt><dd>{selectedAgent.provider}</dd></div>
                  <div><dt>Status</dt><dd><span className={`status-badge status-badge--${selectedAgent.status}`}>{selectedAgent.status}</span></dd></div>
                  <div><dt>Room</dt><dd>{snapshot.rooms.find((r) => r.id === selectedAgent.roomId)?.name}</dd></div>
                </dl>
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
              <p className="inspector-copy">Pick an agent from a room to inspect it.</p>
            )}
          </section>

          {/* Task Wall */}
          <section className="panel">
            <p className="eyebrow">Task Wall</p>
            <div className="task-list">
              {snapshot.tasks.map((task) => (
                <article
                  key={task.id}
                  className={`task-card task-card--${task.status}${expandedTaskId === task.id ? ' task-card--expanded' : ''}`}
                  onClick={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                >
                  <div className="task-meta">
                    <span className={`status-badge status-badge--${task.status}`}>{task.status}</span>
                    <span className={`provider-badge provider-badge--${task.provider}`}>
                      {task.provider === 'copilot' ? '⚡' : '🧠'} {task.provider}
                    </span>
                    <span>{task.source}</span>
                  </div>
                  <h3>{task.title}</h3>
                  <p>{task.detail}</p>
                  {task.output && expandedTaskId === task.id && (
                    <div className="task-output">
                      <p className="eyebrow">Execution Output</p>
                      <pre>{task.output}</pre>
                    </div>
                  )}
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
              ))}
            </div>
          </section>

          {/* Activity Feed */}
          <section className="panel">
            <p className="eyebrow">Activity Feed</p>
            <ul className="activity-feed">
              {activity.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          </section>
        </aside>
      </section>
    </main>
  );
}

export default App;
