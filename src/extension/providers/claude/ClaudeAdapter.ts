import type { ProviderHealth } from '../../../shared/model/index.js';
import type { ProviderAdapter } from '../types.js';

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude';

  getHealth(): ProviderHealth {
    return {
      provider: this.id,
      state: 'stub',
      detail: 'Claude terminal spawning and transcript observation will land in the next slice.'
    };
  }
}
