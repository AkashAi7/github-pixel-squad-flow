import type { AgentStatus } from '../../../src/shared/model/index.js';

const PERSONA_META: Record<string, { accent: string; accentSoft: string; label: string; panel: string }> = {
  frontend: { accent: '#ff7b72', accentSoft: '#ffd1cc', label: '</>', panel: 'FE' },
  backend: { accent: '#59b8ff', accentSoft: '#cbe9ff', label: 'API', panel: 'BE' },
  tester: { accent: '#68d6b3', accentSoft: '#cff7ea', label: 'QA', panel: 'T' },
  testing: { accent: '#68d6b3', accentSoft: '#cff7ea', label: 'QA', panel: 'T' },
  lead: { accent: '#ffcf5a', accentSoft: '#ffefbc', label: 'MAP', panel: 'LD' },
  devops: { accent: '#c78a5c', accentSoft: '#f0d4bf', label: 'OPS', panel: 'DX' },
  design: { accent: '#d88cff', accentSoft: '#f1d6ff', label: 'UX', panel: 'DS' },
  designer: { accent: '#d88cff', accentSoft: '#f1d6ff', label: 'UX', panel: 'DS' },
};

interface AgentSpriteProps {
  personaId: string;
  status: AgentStatus;
  size?: 'stage' | 'card';
}

export function AgentSprite({ personaId, status, size = 'stage' }: AgentSpriteProps) {
  const meta = PERSONA_META[personaId] ?? { accent: '#7d8cff', accentSoft: '#d8dcff', label: 'SDLC', panel: 'AI' };

  return (
    <span
      className={`astronaut-sprite astronaut-sprite--${size} astronaut-sprite--${status}`}
      style={{
        ['--accent' as string]: meta.accent,
        ['--accent-soft' as string]: meta.accentSoft,
      }}
      aria-hidden="true"
    >
      {size === 'stage' ? <span className="astronaut-sprite__label">{meta.label}</span> : null}
      <span className="astronaut-sprite__backpack" />
      <span className="astronaut-sprite__helmet">
        <span className="astronaut-sprite__visor" />
      </span>
      <span className="astronaut-sprite__torso">
        <span className="astronaut-sprite__panel">{meta.panel}</span>
      </span>
      <span className="astronaut-sprite__arm astronaut-sprite__arm--left" />
      <span className="astronaut-sprite__arm astronaut-sprite__arm--right" />
      <span className="astronaut-sprite__leg astronaut-sprite__leg--left" />
      <span className="astronaut-sprite__leg astronaut-sprite__leg--right" />
      <span className="astronaut-sprite__shadow" />
    </span>
  );
}