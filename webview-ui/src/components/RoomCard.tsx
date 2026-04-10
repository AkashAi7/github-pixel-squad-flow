import type { Room, SquadAgent, PersonaTemplate } from '../../../src/shared/model/index.js';

interface RoomCardProps {
  room: Room;
  agents: SquadAgent[];
  personas: PersonaTemplate[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

export function RoomCard({ room, agents, personas, selectedAgentId, onSelectAgent }: RoomCardProps) {
  const personaMap = new Map(personas.map((persona) => [persona.id, persona]));

  return (
    <section className="room-card">
      <header className="room-header">
        <div>
          <p className="eyebrow">{room.theme}</p>
          <h2>{room.name}</h2>
          <p className="room-purpose">{room.purpose}</p>
        </div>
        <span className="room-count">{agents.length} agents</span>
      </header>

      <div className="room-grid">
        {agents.map((agent) => {
          const persona = personaMap.get(agent.personaId);
          return (
            <button
              key={agent.id}
              type="button"
              className={agent.id === selectedAgentId ? 'agent-seat agent-seat--selected' : 'agent-seat'}
              onClick={() => onSelectAgent(agent.id)}
              style={{ ['--accent' as string]: persona?.color ?? '#7d8cff' }}
            >
              <span className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
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
