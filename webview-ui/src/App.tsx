import { useEffect, useMemo, useState } from 'react';

import type { WorkspaceSnapshot, SquadAgent } from '../../src/shared/model/index.js';
import type { ExtensionMessage } from '../../src/shared/protocol/messages.js';
import { RoomCard } from './components/RoomCard.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: (_message: unknown) => undefined };

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activity, setActivity] = useState<string[]>([]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
      if (event.data.type === 'bootstrapState') {
        setSnapshot(event.data.snapshot);
        setActivity(event.data.snapshot.activityFeed);
        setSelectedAgentId(event.data.snapshot.agents[0]?.id ?? null);
      }

      if (event.data.type === 'activity') {
        setActivity((current) => [event.data.message, ...current].slice(0, 8));
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'webviewReady' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const selectedAgent = useMemo<SquadAgent | null>(() => {
    if (!snapshot || !selectedAgentId) {
      return null;
    }

    return snapshot.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  }, [selectedAgentId, snapshot]);

  const personas = useMemo(() => new Map(snapshot?.personas.map((persona) => [persona.id, persona]) ?? []), [snapshot]);

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

  return (
    <main className="shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Agent Factory</p>
          <h1>{snapshot.projectName}</h1>
          <p className="hero-copy">
            A squad-style orchestration surface with rooms, role-driven agents, and provider-aware task routing.
          </p>
        </div>
        <div className="provider-strip">
          {snapshot.providers.map((provider) => (
            <article key={provider.provider} className="provider-chip">
              <span>{provider.provider}</span>
              <strong>{provider.state}</strong>
              <p>{provider.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="layout">
        <div className="column column--rooms">
          {snapshot.rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              agents={snapshot.agents.filter((agent) => agent.roomId === room.id)}
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
          <section className="panel inspector-panel">
            <p className="eyebrow">Selected Agent</p>
            {selectedAgent ? (
              <>
                <h2>{selectedAgent.name}</h2>
                <div className="persona-pill" style={{ ['--accent' as string]: personas.get(selectedAgent.personaId)?.color ?? '#7d8cff' }}>
                  {personas.get(selectedAgent.personaId)?.title ?? selectedAgent.personaId}
                </div>
                <p className="inspector-copy">{selectedAgent.summary}</p>
                <dl className="facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>{selectedAgent.provider}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{selectedAgent.status}</dd>
                  </div>
                  <div>
                    <dt>Room</dt>
                    <dd>{snapshot.rooms.find((room) => room.id === selectedAgent.roomId)?.name}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="inspector-copy">Pick an agent from a room to inspect it.</p>
            )}
          </section>

          <section className="panel">
            <p className="eyebrow">Task Wall</p>
            <div className="task-list">
              {snapshot.tasks.map((task) => (
                <article key={task.id} className={`task-card task-card--${task.status}`}>
                  <div className="task-meta">
                    <span>{task.provider}</span>
                    <span>{task.source}</span>
                  </div>
                  <h3>{task.title}</h3>
                  <p>{task.detail}</p>
                </article>
              ))}
            </div>
          </section>

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
