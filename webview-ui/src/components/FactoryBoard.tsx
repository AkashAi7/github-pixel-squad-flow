import { useEffect, useMemo, useRef, useState } from 'react';

import type { AgentStatus, PersonaTemplate, Room, SquadAgent, TaskCard } from '../../../src/shared/model/index.js';
import { AGENT_MOOD } from '../../../src/shared/model/index.js';
import { AgentSprite } from './AgentSprite.js';

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

interface AgentMotion {
  x: number;
  y: number;
  durationMs: number;
  facing: 'left' | 'right';
}

const STAGE_BOUNDS = {
  minX: 10,
  maxX: 90,
  minY: 22,
  maxY: 82,
  minGap: 14,
};

const STATUS_MOTION_PROFILE: Record<AgentStatus, { step: [number, number]; duration: [number, number] }> = {
  idle:      { step: [0.8, 2.0], duration: [5000, 8000] },
  planning:  { step: [0.5, 1.2], duration: [5500, 8500] },
  executing: { step: [1.2, 2.5], duration: [4500, 7000] },
  waiting:   { step: [0.4, 1.0], duration: [6000, 9000] },
  blocked:   { step: [0.2, 0.6], duration: [7000, 10000] },
  paused:    { step: [0.1, 0.4], duration: [8000, 12000] },
  completed: { step: [0.8, 2.0], duration: [5000, 8000] },
  failed:    { step: [0.2, 0.6], duration: [7000, 10000] },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(a: Pick<AgentMotion, 'x' | 'y'>, b: Pick<AgentMotion, 'x' | 'y'>): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashUnit(seed: number): number {
  return seed / 0xffffffff;
}

function interpolate(range: [number, number], unit: number): number {
  return range[0] + (range[1] - range[0]) * unit;
}

function seedMotion(agent: SquadAgent, roomId: string, index: number): AgentMotion {
  const columns = Math.max(1, Math.ceil(Math.sqrt(index + 1)));
  const baseColumn = index % columns;
  const baseRow = Math.floor(index / columns);
  const rowCount = Math.max(1, Math.ceil((index + 1) / columns));
  const seed = hashString(`${roomId}:${agent.id}:spawn`);
  const jitterX = (hashUnit(hashString(`${seed}:x`)) - 0.5) * 10;
  const jitterY = (hashUnit(hashString(`${seed}:y`)) - 0.5) * 8;
  const x = clamp(
    STAGE_BOUNDS.minX + ((baseColumn + 0.5) / columns) * (STAGE_BOUNDS.maxX - STAGE_BOUNDS.minX) + jitterX,
    STAGE_BOUNDS.minX,
    STAGE_BOUNDS.maxX,
  );
  const y = clamp(
    STAGE_BOUNDS.minY + ((baseRow + 0.5) / rowCount) * (STAGE_BOUNDS.maxY - STAGE_BOUNDS.minY) + jitterY,
    STAGE_BOUNDS.minY,
    STAGE_BOUNDS.maxY,
  );

  return {
    x,
    y,
    durationMs: Math.round(interpolate([1400, 2200], hashUnit(hashString(`${seed}:duration`)))),
    facing: hashUnit(hashString(`${seed}:facing`)) > 0.5 ? 'left' : 'right',
  };
}

function pickNextMotion(
  agent: SquadAgent,
  roomId: string,
  tick: number,
  index: number,
  previous: AgentMotion | undefined,
  occupied: AgentMotion[],
): AgentMotion {
  const profile = STATUS_MOTION_PROFILE[agent.status];
  const fallback = previous ?? seedMotion(agent, roomId, index);
  let bestCandidate = fallback;
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const angle = hashUnit(hashString(`${roomId}:${agent.id}:${tick}:${attempt}:angle`)) * Math.PI * 2;
    const step = interpolate(profile.step, hashUnit(hashString(`${roomId}:${agent.id}:${tick}:${attempt}:step`)));
    const candidate = {
      x: clamp(fallback.x + Math.cos(angle) * step, STAGE_BOUNDS.minX, STAGE_BOUNDS.maxX),
      y: clamp(fallback.y + Math.sin(angle) * step * 0.72, STAGE_BOUNDS.minY, STAGE_BOUNDS.maxY),
    };
    const nearest = occupied.length === 0
      ? Infinity
      : Math.min(...occupied.map((motion) => distanceBetween(candidate, motion)));
    const edgeClearance = Math.min(
      candidate.x - STAGE_BOUNDS.minX,
      STAGE_BOUNDS.maxX - candidate.x,
      candidate.y - STAGE_BOUNDS.minY,
      STAGE_BOUNDS.maxY - candidate.y,
    );
    const score = nearest + edgeClearance * 0.35;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = {
        x: candidate.x,
        y: candidate.y,
        durationMs: fallback.durationMs,
        facing: candidate.x < fallback.x - 0.75 ? 'left' : candidate.x > fallback.x + 0.75 ? 'right' : fallback.facing,
      };
    }

    if (nearest >= STAGE_BOUNDS.minGap) {
      break;
    }
  }

  const travelDistance = distanceBetween(fallback, bestCandidate);
  return {
    ...bestCandidate,
    durationMs: Math.round(clamp(profile.duration[0] + travelDistance * 80, profile.duration[0], profile.duration[1])),
  };
}

function layoutAgentMotions(
  roomId: string,
  roomAgents: SquadAgent[],
  tick: number,
  previous: Record<string, AgentMotion>,
): Record<string, AgentMotion> {
  const occupied: AgentMotion[] = [];
  const next: Record<string, AgentMotion> = {};

  roomAgents.forEach((agent, index) => {
    const motion = pickNextMotion(agent, roomId, tick, index, previous[agent.id], occupied);
    occupied.push(motion);
    next[agent.id] = motion;
  });

  return next;
}

interface RoomStageProps {
  room: Room;
  roomAgents: SquadAgent[];
  personaMap: Map<string, PersonaTemplate>;
  tasks: TaskCard[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onSpawnAgent: (roomId: string) => void;
  onRemoveAgent: (agentId: string) => void;
}

function RoomStage({
  room,
  roomAgents,
  personaMap,
  tasks,
  selectedAgentId,
  onSelectAgent,
  onSpawnAgent,
  onRemoveAgent,
}: RoomStageProps) {
  const [motions, setMotions] = useState<Record<string, AgentMotion>>({});
  const tickRef = useRef(0);
  const agentSignature = roomAgents.map((agent) => `${agent.id}:${agent.status}`).join('|');
  const taskMap = useMemo(
    () => new Map(tasks.filter((task) => task.status === 'active' || task.status === 'queued').map((task) => [task.assigneeId, task])),
    [tasks],
  );

  useEffect(() => {
    setMotions((current) => layoutAgentMotions(room.id, roomAgents, tickRef.current, current));
  }, [room.id, roomAgents, agentSignature]);

  useEffect(() => {
    if (roomAgents.length === 0) {
      setMotions({});
      return undefined;
    }

    const interval = window.setInterval(() => {
      tickRef.current += 1;
      setMotions((current) => layoutAgentMotions(room.id, roomAgents, tickRef.current, current));
    }, 3600);

    return () => window.clearInterval(interval);
  }, [room.id, roomAgents, agentSignature]);

  return (
    <div className="factory-room__stage" data-room-theme={room.theme} role="list" aria-label={`${room.name} stage`}>
      {roomAgents.map((agent, index) => {
        const persona = personaMap.get(agent.personaId);
        const mood = AGENT_MOOD[agent.status];
        const agentTask = taskMap.get(agent.id);
        const motion = motions[agent.id] ?? seedMotion(agent, room.id, index);
        const isSelected = agent.id === selectedAgentId;
        const providerGlyph = agent.provider === 'copilot' ? '⚡' : '🧠';

        return (
          <div
            key={agent.id}
            className={`pixel-agent-shell${isSelected ? ' pixel-agent-shell--selected' : ''}`}
            data-status={agent.status}
            style={{
              ['--agent-x' as string]: `${motion.x}%`,
              ['--agent-y' as string]: `${motion.y}%`,
              ['--agent-z' as string]: String(Math.round(motion.y * 10)),
              ['--wander-duration' as string]: `${motion.durationMs}ms`,
            }}
            role="listitem"
          >
            <button
              type="button"
              className={`pixel-agent${isSelected ? ' pixel-agent--selected' : ''}`}
              style={{ ['--accent' as string]: persona?.color ?? '#7d8cff' }}
              onClick={() => onSelectAgent(agent.id)}
              title={`${agent.name} · ${persona?.title ?? agent.personaId} · ${agent.provider} · ${agent.status}`}
              aria-label={`${agent.name}, ${persona?.title ?? agent.personaId}, status: ${agent.status}, provider: ${agent.provider}${isSelected ? ', selected' : ''}`}
              aria-pressed={isSelected}
            >
              <span className="pixel-agent__mood-badge" title={mood.label} aria-hidden="true">{mood.emoji}</span>
              <span className={`pixel-agent__provider pixel-agent__provider--${agent.provider}`} aria-hidden="true">{providerGlyph}</span>
              {agentTask && (agent.status === 'executing' || agent.status === 'planning') && (
                <div className="thought-bubble">
                  <span className="thought-bubble__text">
                    {agentTask.title.length > 28 ? `${agentTask.title.slice(0, 25)}...` : agentTask.title}
                  </span>
                </div>
              )}
              <span className="pixel-agent__sprite">
                <AgentSprite personaId={agent.personaId} status={agent.status} size="stage" />
              </span>
              <span className="pixel-agent__caption">
                <span className="pixel-agent__label">{agent.name}</span>
                <span className="pixel-agent__meta">{mood.label}</span>
              </span>
            </button>
            <button
              type="button"
              className="pixel-agent__remove"
              title={`Remove ${agent.name}`}
              aria-label={`Remove agent ${agent.name}`}
              onClick={() => onRemoveAgent(agent.id)}
            >
              ×
            </button>
          </div>
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
  );
}

export function FactoryBoard({
  rooms, agents, personas, tasks, selectedAgentId, onSelectAgent, onSpawnAgent, onDeleteRoom, onRemoveAgent,
}: FactoryBoardProps) {
  const personaMap = useMemo(() => new Map(personas.map((persona) => [persona.id, persona])), [personas]);

  return (
    <section className="factory-board panel" aria-labelledby="factory-board-title">
      <div className="factory-board__header">
        <div>
          <p className="eyebrow">Pixel Floor</p>
          <h2 id="factory-board-title">Agent Factory</h2>
        </div>
        <p className="factory-board__copy">
          Create rooms, spawn agents, and visualize your multi-agent squad working in parallel.
        </p>
      </div>
      <div className="factory-board__grid" role="list" aria-label="Factory rooms">
        {rooms.map((room) => {
          const roomAgents = agents.filter((a) => a.roomId === room.id);
          const roomActiveTasks = tasks.filter((task) => {
            const assignee = agents.find((agent) => agent.id === task.assigneeId);
            return assignee?.roomId === room.id && (task.status === 'active' || task.status === 'queued' || task.status === 'review');
          }).length;
          const roomBusyAgents = roomAgents.filter((agent) => agent.status !== 'idle' && agent.status !== 'completed').length;
          const roomHasSelection = roomAgents.some((agent) => agent.id === selectedAgentId);
          const roomHasLiveWork = roomActiveTasks > 0 || roomBusyAgents > 0;
          return (
            <article
              key={room.id}
              className={`factory-room${roomHasSelection ? ' factory-room--selected' : ''}${roomHasLiveWork ? ' factory-room--live' : ''}`}
              style={{
                ['--room-color' as string]: room.color,
                background: THEME_FLOORS[room.theme] ?? THEME_FLOORS.general,
              }}
              role="listitem"
              aria-label={`${room.name} room with ${roomAgents.length} agents, ${roomHasLiveWork ? 'active' : 'idle'}`}
            >
              <header className="factory-room__header">
                <div className="factory-room__title">
                  <strong>{room.name}</strong>
                  <span className="factory-room__theme">{room.theme}</span>
                </div>
                <span className={`factory-room__state${roomHasLiveWork ? ' factory-room__state--live' : ''}`}>
                  {roomHasLiveWork ? 'Live' : 'Ready'}
                </span>
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
              <div className="factory-room__metrics">
                <span className="factory-room__metric">{roomAgents.length} agents</span>
                <span className="factory-room__metric">{roomBusyAgents} busy</span>
                <span className="factory-room__metric">{roomActiveTasks} queued</span>
              </div>
              <RoomStage
                room={room}
                roomAgents={roomAgents}
                personaMap={personaMap}
                tasks={tasks}
                selectedAgentId={selectedAgentId}
                onSelectAgent={onSelectAgent}
                onSpawnAgent={onSpawnAgent}
                onRemoveAgent={onRemoveAgent}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}
