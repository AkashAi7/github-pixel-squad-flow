import type { AgentStatus } from '../../../src/shared/model/index.js';

const METROCITY_SPRITES = [
  new URL('../assets/metrocity/agent-1.png', import.meta.url).href,
  new URL('../assets/metrocity/agent-2.png', import.meta.url).href,
  new URL('../assets/metrocity/agent-3.png', import.meta.url).href,
];

interface AgentSpriteProps {
  variant: number;
  status: AgentStatus;
  size?: 'stage' | 'card';
}

export function AgentSprite({ variant, status, size = 'stage' }: AgentSpriteProps) {
  const spriteUrl = METROCITY_SPRITES[Math.abs(variant) % METROCITY_SPRITES.length];

  return (
    <span className={`metro-agent metro-agent--${size} metro-agent--${status}`} aria-hidden="true">
      <span className="metro-agent__sprite" style={{ backgroundImage: `url(${spriteUrl})` }} />
    </span>
  );
}