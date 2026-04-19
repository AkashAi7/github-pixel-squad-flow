import { useMemo } from 'react';

import type {
  AgentMessage,
  AgentSession,
  AgentSessionMessage,
  HandoffPacket,
  PersonaTemplate,
  ProposedFileEdit,
  Room,
  SquadAgent,
  TaskCard,
  WorkspaceSnapshot,
} from '../../../src/shared/model/index.js';
import { AGENT_MOOD } from '../../../src/shared/model/index.js';

/** A single item on the agent's timeline. */
type JournalEntry =
  | { kind: 'task'; timestamp: number; task: TaskCard }
  | { kind: 'file'; timestamp: number; task: TaskCard; edit: ProposedFileEdit }
  | { kind: 'command'; timestamp: number; task: TaskCard; command: string; status: string; summary: string }
  | { kind: 'handoff'; timestamp: number; task: TaskCard; packet: HandoffPacket }
  | { kind: 'message'; timestamp: number; message: AgentMessage; direction: 'sent' | 'received' }
  | { kind: 'session'; timestamp: number; session: AgentSession; message: AgentSessionMessage };

export interface AgentJournalProps {
  selectedAgent: SquadAgent | null;
  displayAgents: SquadAgent[];
  snapshot: WorkspaceSnapshot;
  personas: Map<string, PersonaTemplate>;
  rooms: Room[];
  agentsById: Map<string, SquadAgent>;
  onSelectAgent: (agentId: string) => void;
}

function formatDayHeader(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function groupByDay(entries: JournalEntry[]): Array<{ day: string; anchor: number; entries: JournalEntry[] }> {
  const buckets = new Map<string, { anchor: number; entries: JournalEntry[] }>();
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const bucket = buckets.get(key) ?? { anchor: entry.timestamp, entries: [] };
    bucket.entries.push(entry);
    if (entry.timestamp > bucket.anchor) bucket.anchor = entry.timestamp;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .map(([, value]) => ({ day: formatDayHeader(value.anchor), anchor: value.anchor, entries: value.entries }))
    .sort((a, b) => b.anchor - a.anchor);
}

function collectFileProvenance(tasks: TaskCard[]) {
  const files = new Map<string, { action: 'create' | 'replace'; count: number; lastTouched: number; lastSummary: string }>();
  for (const task of tasks) {
    const edits = task.executionPlan?.fileEdits ?? [];
    for (const edit of edits) {
      const prev = files.get(edit.filePath);
      const touched = task.updatedAt ?? task.createdAt ?? Date.now();
      if (!prev || touched > prev.lastTouched) {
        files.set(edit.filePath, {
          action: edit.action,
          count: (prev?.count ?? 0) + 1,
          lastTouched: touched,
          lastSummary: edit.summary,
        });
      } else {
        prev.count += 1;
        files.set(edit.filePath, prev);
      }
    }
  }
  return Array.from(files.entries())
    .sort((a, b) => b[1].lastTouched - a[1].lastTouched);
}

function buildEntries(agent: SquadAgent, snapshot: WorkspaceSnapshot): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const agentTasks = snapshot.tasks.filter((task) => task.assigneeId === agent.id);

  for (const task of agentTasks) {
    entries.push({ kind: 'task', timestamp: task.createdAt ?? Date.now(), task });
    const edits = task.executionPlan?.fileEdits ?? [];
    for (const edit of edits) {
      entries.push({ kind: 'file', timestamp: task.updatedAt ?? task.createdAt ?? Date.now(), task, edit });
    }
    const commandResults = task.executionPlan?.commandResults ?? [];
    for (const result of commandResults) {
      entries.push({
        kind: 'command',
        timestamp: result.completedAt ?? result.startedAt ?? task.updatedAt ?? Date.now(),
        task,
        command: result.command,
        status: result.status,
        summary: result.summary,
      });
    }
    const handoffs = task.handoffPackets ?? [];
    for (const packet of handoffs) {
      entries.push({ kind: 'handoff', timestamp: task.updatedAt ?? task.createdAt ?? Date.now(), task, packet });
    }
  }

  // Inter-agent mailbox messages (sent or received).
  const roomFeeds = snapshot.roomFeeds ?? {};
  for (const messages of Object.values(roomFeeds)) {
    for (const message of messages) {
      if (message.fromAgentId === agent.id) {
        entries.push({ kind: 'message', timestamp: message.timestamp, message, direction: 'sent' });
      } else if (message.toAgentId === agent.id) {
        entries.push({ kind: 'message', timestamp: message.timestamp, message, direction: 'received' });
      }
    }
  }

  // Session log turns (user ↔ agent).
  const sessions = snapshot.agentSessions.filter((session) => session.agentId === agent.id);
  for (const session of sessions) {
    for (const message of session.messageLog) {
      entries.push({ kind: 'session', timestamp: message.timestamp, session, message });
    }
  }

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

function renderEntry(entry: JournalEntry, agentsById: Map<string, SquadAgent>): JSX.Element {
  switch (entry.kind) {
    case 'task':
      return (
        <div className={`journal-entry journal-entry--task journal-entry--${entry.task.status}`}>
          <div className="journal-entry__head">
            <span className="journal-entry__icon" aria-hidden="true">⎔</span>
            <strong>Task: {entry.task.title}</strong>
            <span className={`journal-entry__badge journal-entry__badge--${entry.task.status}`}>{entry.task.status}</span>
          </div>
          <p className="journal-entry__detail">{entry.task.detail}</p>
        </div>
      );
    case 'file':
      return (
        <div className={`journal-entry journal-entry--file journal-entry--file-${entry.edit.action}`}>
          <div className="journal-entry__head">
            <span className="journal-entry__icon" aria-hidden="true">
              {entry.edit.action === 'create' ? '＋' : '✎'}
            </span>
            <strong className="journal-entry__file">{entry.edit.filePath}</strong>
            <span className={`journal-entry__badge journal-entry__badge--${entry.edit.action}`}>
              {entry.edit.action === 'create' ? 'created' : 'edited'}
            </span>
          </div>
          {entry.edit.summary ? <p className="journal-entry__detail">{entry.edit.summary}</p> : null}
          <p className="journal-entry__meta">via “{entry.task.title}”</p>
        </div>
      );
    case 'command':
      return (
        <div className={`journal-entry journal-entry--command journal-entry--cmd-${entry.status}`}>
          <div className="journal-entry__head">
            <span className="journal-entry__icon" aria-hidden="true">⌘</span>
            <code className="journal-entry__code">{entry.command}</code>
            <span className={`journal-entry__badge journal-entry__badge--${entry.status}`}>{entry.status}</span>
          </div>
          {entry.summary ? <p className="journal-entry__detail">{entry.summary}</p> : null}
          <p className="journal-entry__meta">during “{entry.task.title}”</p>
        </div>
      );
    case 'handoff':
      return (
        <div className="journal-entry journal-entry--handoff">
          <div className="journal-entry__head">
            <span className="journal-entry__icon" aria-hidden="true">↪</span>
            <strong>Handoff from {entry.packet.fromAgentName}</strong>
          </div>
          <p className="journal-entry__detail">{entry.packet.summary}</p>
          {entry.packet.filesChanged.length > 0 ? (
            <div className="journal-chiprow">
              {entry.packet.filesChanged.slice(0, 6).map((file) => (
                <span key={file} className="journal-chip journal-chip--file">{file}</span>
              ))}
              {entry.packet.filesChanged.length > 6 ? (
                <span className="journal-chip journal-chip--more">+{entry.packet.filesChanged.length - 6}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    case 'message': {
      const other = entry.direction === 'sent' ? entry.message.toAgentId : entry.message.fromAgentId;
      const otherAgent = agentsById.get(other);
      return (
        <div className={`journal-entry journal-entry--message journal-entry--message-${entry.direction}`}>
          <div className="journal-entry__head">
            <span className="journal-entry__icon" aria-hidden="true">
              {entry.direction === 'sent' ? '→' : '←'}
            </span>
            <strong>
              {entry.direction === 'sent' ? 'To' : 'From'} {otherAgent?.name ?? other}
            </strong>
            <span className={`journal-entry__badge journal-entry__badge--${entry.message.type}`}>{entry.message.type}</span>
          </div>
          <p className="journal-entry__detail">{entry.message.content}</p>
        </div>
      );
    }
    case 'session':
      return (
        <div className={`journal-entry journal-entry--session journal-entry--session-${entry.message.role}`}>
          <div className="journal-entry__head">
            <span className="journal-entry__icon" aria-hidden="true">
              {entry.message.role === 'user' ? '🗣' : entry.message.role === 'agent' ? '◉' : '•'}
            </span>
            <strong>{entry.message.role === 'user' ? 'You' : entry.message.role === 'agent' ? 'Agent reply' : 'System'}</strong>
          </div>
          <p className="journal-entry__detail">{entry.message.content}</p>
        </div>
      );
  }
}

export function AgentJournalComponent({
  selectedAgent,
  displayAgents,
  snapshot,
  personas,
  rooms,
  agentsById,
  onSelectAgent,
}: AgentJournalProps) {
  const agent = selectedAgent;

  const entries = useMemo(() => (agent ? buildEntries(agent, snapshot) : []), [agent, snapshot]);
  const grouped = useMemo(() => groupByDay(entries), [entries]);
  const agentTasks = useMemo(
    () => (agent ? snapshot.tasks.filter((task) => task.assigneeId === agent.id) : []),
    [agent, snapshot],
  );
  const fileProvenance = useMemo(() => collectFileProvenance(agentTasks), [agentTasks]);

  const persona = agent ? personas.get(agent.personaId) : null;
  const room = agent ? rooms.find((r) => r.id === agent.roomId) : null;
  const mood = agent ? AGENT_MOOD[agent.status] : null;

  const taskStats = useMemo(() => ({
    total: agentTasks.length,
    active: agentTasks.filter((t) => t.status === 'active').length,
    done: agentTasks.filter((t) => t.status === 'done').length,
    failed: agentTasks.filter((t) => t.status === 'failed').length,
  }), [agentTasks]);

  return (
    <section className="workspace-stack workspace-stack--journal" aria-labelledby="journal-title">
      <div className="workspace-stack__main">
        <section className="panel journal-panel">
          <div className="journal-panel__head">
            <div>
              <p className="eyebrow" id="journal-title">Agent Journal</p>
              <h2>{agent ? `${agent.name}'s notebook` : 'Pick a teammate'}</h2>
              <p className="journal-panel__subtitle">
                {agent
                  ? `Everything ${agent.name} has done in this repo: tasks, files touched, commands run, handoffs, and conversations.`
                  : 'Select an agent from the list to see a chronological record of their work.'}
              </p>
            </div>
            {agent && mood ? (
              <div className="journal-panel__mood">
                <span className="journal-mood">{mood.emoji} {mood.label}</span>
                {persona ? <span className="journal-role">{persona.title}</span> : null}
                {room ? <span className="journal-room">{room.name}</span> : null}
              </div>
            ) : null}
          </div>

          {agent ? (
            <div className="journal-stats" role="list" aria-label="Agent work stats">
              <article className="journal-stat" role="listitem"><strong>{taskStats.total}</strong><span>tasks</span></article>
              <article className="journal-stat" role="listitem"><strong>{taskStats.active}</strong><span>active</span></article>
              <article className="journal-stat" role="listitem"><strong>{taskStats.done}</strong><span>done</span></article>
              <article className="journal-stat journal-stat--danger" role="listitem"><strong>{taskStats.failed}</strong><span>failed</span></article>
              <article className="journal-stat" role="listitem"><strong>{fileProvenance.length}</strong><span>files touched</span></article>
            </div>
          ) : null}

          {agent ? (
            <div className="journal-timeline" role="list" aria-label={`${agent.name} timeline`}>
              {grouped.length === 0 ? (
                <div className="journal-empty">
                  <p>No activity yet. When {agent.name} picks up work, it'll show up here as a timeline with file provenance, commands run, and handoffs sent or received.</p>
                </div>
              ) : null}
              {grouped.map((bucket) => (
                <div key={bucket.day} className="journal-day" role="listitem">
                  <h3 className="journal-day__head">{bucket.day}</h3>
                  <ul className="journal-day__entries" role="list">
                    {bucket.entries.map((entry, index) => (
                      <li key={`${entry.kind}-${entry.timestamp}-${index}`} className="journal-day__entry" role="listitem">
                        <time className="journal-day__time" dateTime={new Date(entry.timestamp).toISOString()}>
                          {formatTime(entry.timestamp)}
                        </time>
                        <div className="journal-day__body">{renderEntry(entry, agentsById)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <aside className="workspace-stack__side">
        <section className="panel journal-sidebar">
          <p className="eyebrow">Teammates</p>
          <ul className="journal-roster" role="list">
            {displayAgents.map((candidate) => {
              const candidateMood = AGENT_MOOD[candidate.status];
              const candidatePersona = personas.get(candidate.personaId);
              const isActive = agent?.id === candidate.id;
              return (
                <li key={candidate.id} role="listitem">
                  <button
                    type="button"
                    className={`journal-roster__row${isActive ? ' journal-roster__row--active' : ''}`}
                    onClick={() => onSelectAgent(candidate.id)}
                  >
                    <span className="journal-roster__mood" aria-hidden="true">{candidateMood.emoji}</span>
                    <span className="journal-roster__text">
                      <strong>{candidate.name}</strong>
                      <span>{candidatePersona?.title ?? candidate.personaId}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {agent && fileProvenance.length > 0 ? (
          <section className="panel journal-sidebar">
            <p className="eyebrow">Files touched</p>
            <ul className="journal-filelist" role="list">
              {fileProvenance.slice(0, 12).map(([path, info]) => (
                <li key={path} role="listitem" className="journal-filelist__row">
                  <span className={`journal-chip journal-chip--${info.action}`}>{info.action}</span>
                  <span className="journal-filelist__path" title={path}>{path}</span>
                  {info.count > 1 ? <span className="journal-filelist__count">×{info.count}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    </section>
  );
}
