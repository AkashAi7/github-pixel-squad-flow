import type { PersonaTemplate, Room, SquadAgent, TaskCard } from '../../../src/shared/model/index.js';
import { AGENT_MOOD, xpForLevel } from '../../../src/shared/model/index.js';

interface FactoryBoardProps {
  rooms: Room[];
  agents: SquadAgent[];
  personas: PersonaTemplate[];
  tasks: TaskCard[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onSpawnAgent: (roomId: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onRemoveAgent: (agentId: string) => void;
}

const THEME_FLOORS: Record<string, string> = {
  frontend: 'linear-gradient(135deg, rgba(242,95,92,0.08) 0%, rgba(242,95,92,0.02) 100%)',
  backend:  'linear-gradient(135deg, rgba(36,123,160,0.08) 0%, rgba(36,123,160,0.02) 100%)',
  devops:   'linear-gradient(135deg, rgba(141,110,99,0.08) 0%, rgba(141,110,99,0.02) 100%)',
  testing:  'linear-gradient(135deg, rgba(112,193,179,0.08) 0%, rgba(112,193,179,0.02) 100%)',
  design:   'linear-gradient(135deg, rgba(206,147,216,0.08) 0%, rgba(206,147,216,0.02) 100%)',
  general:  'linear-gradient(135deg, rgba(255,224,102,0.08) 0%, rgba(255,224,102,0.02) 100%)',
};

export function FactoryBoard({
  rooms, agents, personas, tasks, selectedAgentId, onSelectAgent, onSpawnAgent, onDeleteRoom, onRemoveAgent,
}: FactoryBoardProps) {
  const personaMap = new Map(personas.map((p) => [p.id, p]));

  return (
    <section className="factory-board panel">
      <div className="factory-board__header">
        <div>
          <p className="eyebrow">Pixel Floor</p>
          <h2>Agent Factory</h2>
        </div>
        <p className="factory-board__copy">
          Create rooms, spawn agents, and visualize your multi-agent squad working in parallel.
        </p>
      </div>
      <div className="factory-board__grid">
        {rooms.map((room) => {
          const roomAgents = agents.filter((a) => a.roomId === room.id);
          return (
            <article
              key={room.id}
              className="factory-room"
              style={{
                ['--room-color' as string]: room.color,
                background: THEME_FLOORS[room.theme] ?? THEME_FLOORS.general,
              }}
            >
              <header className="factory-room__header">
                <div className="factory-room__title">
                  <strong>{room.name}</strong>
                  <span className="factory-room__theme">{room.theme}</span>
                </div>
                <div className="factory-room__actions">
                  <button
                    type="button"
                    className="icon-btn icon-btn--add"
                    title="Spawn agent in this room"
                    onClick={() => onSpawnAgent(room.id)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--remove"
                    title="Delete this room"
                    onClick={() => onDeleteRoom(room.id)}
                  >
                    ×
                  </button>
                </div>
              </header>
              <p className="factory-room__purpose">{room.purpose}</p>
              <div className="factory-room__tiles">
                {roomAgents.map((agent) => {
                  const persona = personaMap.get(agent.personaId);
                  const mood = AGENT_MOOD[agent.status];
                  const agentTask = tasks.find((t) => t.assigneeId === agent.id && (t.status === 'active' || t.status === 'queued'));
                  const level = agent.level ?? 0;
                  const xp = agent.xp ?? 0;
                  const nextLevelXp = xpForLevel(level + 1);
                  const xpProgress = nextLevelXp > 0 ? Math.min(100, Math.round((xp / nextLevelXp) * 100)) : 100;
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={`pixel-agent${agent.id === selectedAgentId ? ' pixel-agent--selected' : ''}`}
                      style={{ ['--accent' as string]: persona?.color ?? '#7d8cff' }}
                      onClick={() => onSelectAgent(agent.id)}
                      title={`${agent.name} · ${persona?.title ?? agent.personaId} · ${agent.provider} · ${agent.status}`}
                    >
                      {/* Mood emoji */}
                      <span className="pixel-agent__mood" title={mood.label}>{mood.emoji}</span>
                      {/* Thought bubble when working */}
                      {agentTask && (agent.status === 'executing' || agent.status === 'planning') && (
                        <div className="thought-bubble">
                          <span className="thought-bubble__text">
                            {agentTask.title.length > 30 ? agentTask.title.slice(0, 27) + '...' : agentTask.title}
                          </span>
                        </div>
                      )}
                      <div className={`pixel-char pixel-char--v${agent.spriteVariant} pixel-char--${agent.status}`}>
                        <div className="pixel-char__head" />
                        <div className="pixel-char__body" />
                        <div className="pixel-char__legs" />
                      </div>
                      <span className="pixel-agent__label">{agent.name}</span>
                      {/* XP / Level badge */}
                      <span className="pixel-agent__level" title={`${xp} XP · Next level: ${nextLevelXp} XP`}>
                        Lv.{level}
                        <span className="xp-bar"><span className="xp-bar__fill" style={{ width: `${xpProgress}%` }} /></span>
                      </span>
                      <span className={`pixel-agent__provider pixel-agent__provider--${agent.provider}`}>
                        {agent.provider === 'copilot' ? '⚡' : '🧠'}
                      </span>
                      <span className={`pixel-agent__status pixel-agent__status--${agent.status}`}>{agent.status}</span>
                      <button
                        type="button"
                        className="pixel-agent__remove"
                        title={`Remove ${agent.name}`}
                        onClick={(e) => { e.stopPropagation(); onRemoveAgent(agent.id); }}
                      >
                        ×
                      </button>
                    </button>
                  );
                })}
                {roomAgents.length === 0 && (
                  <button
                    type="button"
                    className="factory-room__empty"
                    onClick={() => onSpawnAgent(room.id)}
                  >
                    + Spawn Agent
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
