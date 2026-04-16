import type { Room, SquadAgent, PersonaTemplate } from '../../../src/shared/model/index.js';
import { AgentSprite } from './AgentSprite.js';

interface RoomCardProps {
  room: Room;
  agents: SquadAgent[];
  personas: PersonaTemplate[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

export function RoomCard({ room, agents, personas, selectedAgentId, onSelectAgent }: RoomCardProps) {
  const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
  const busyAgents = agents.filter((agent) => agent.status !== 'idle' && agent.status !== 'completed').length;

  const roomTitleId = `room-title-${room.id}`;

  return (
    <section className="room-card" aria-labelledby={roomTitleId}>
      <header className="room-header">
        <div>
          <p className="eyebrow">{room.theme}</p>
          <h2 id={roomTitleId}>{room.name}</h2>
          <p className="room-purpose">{room.purpose}</p>
        </div>
        <div className="room-counts" aria-label={`${agents.length} agents, ${busyAgents} busy`}>
          <span className="room-count">{agents.length} agents</span>
          <span className="room-count room-count--muted">{busyAgents} busy</span>
        </div>
      </header>

      <div className="room-grid" role="list" aria-label={`Agents in ${room.name}`}>
        {agents.map((agent) => {
          const persona = personaMap.get(agent.personaId);
          const isSelected = agent.id === selectedAgentId;
          return (
            <button
              key={agent.id}
              type="button"
              className={isSelected ? 'agent-seat agent-seat--selected' : 'agent-seat'}
              onClick={() => onSelectAgent(agent.id)}
              style={{ ['--accent' as string]: persona?.color ?? '#7d8cff' }}
              role="listitem"
              aria-label={`${agent.name}, ${persona?.title ?? agent.personaId}, status: ${agent.status}`}
              aria-pressed={isSelected}
            >
              <span className="agent-avatar" aria-hidden="true">
                <AgentSprite personaId={agent.personaId} status={agent.status} size="card" />
              </span>
              <span className="agent-name">{agent.name}</span>
              <span className="agent-role">{persona?.title ?? agent.personaId}</span>
              <span className={`agent-status agent-status--${agent.status}`}>{agent.status}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
