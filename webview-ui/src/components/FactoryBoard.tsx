import type { PersonaTemplate, Room, SquadAgent } from '../../../src/shared/model/index.js';

interface FactoryBoardProps {
  rooms: Room[];
  agents: SquadAgent[];
  personas: PersonaTemplate[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

export function FactoryBoard({ rooms, agents, personas, selectedAgentId, onSelectAgent }: FactoryBoardProps) {
  const personaMap = new Map(personas.map((persona) => [persona.id, persona]));

  return (
    <section className="factory-board panel">
      <div className="factory-board__header">
        <div>
          <p className="eyebrow">Pixel Floor</p>
          <h2>Squad Rooms</h2>
        </div>
        <p className="factory-board__copy">A compact board view of rooms and agents so the factory looks alive instead of purely list-driven.</p>
      </div>
      <div className="factory-board__grid">
        {rooms.map((room) => {
          const roomAgents = agents.filter((agent) => agent.roomId === room.id);
          return (
            <article key={room.id} className="factory-room">
              <header className="factory-room__header">
                <strong>{room.name}</strong>
                <span>{roomAgents.length} active</span>
              </header>
              <div className="factory-room__tiles">
                {roomAgents.map((agent) => {
                  const persona = personaMap.get(agent.personaId);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={agent.id === selectedAgentId ? 'pixel-agent pixel-agent--selected' : 'pixel-agent'}
                      style={{ ['--accent' as string]: persona?.color ?? '#7d8cff' }}
                      onClick={() => onSelectAgent(agent.id)}
                      title={`${agent.name} · ${persona?.title ?? agent.personaId}`}
                    >
                      <span className="pixel-agent__sprite" />
                      <span className="pixel-agent__label">{agent.name}</span>
                    </button>
                  );
                })}
                {roomAgents.length === 0 ? <div className="factory-room__empty">Vacant</div> : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
