import type { ProviderHealth } from '../../../shared/model/index.js';
import type { ProviderAdapter } from '../types.js';

export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot';

  getHealth(): ProviderHealth {
    return {
      provider: this.id,
      state: 'stub',
      detail: 'GitHub-model orchestration will be owned by Pixel Squad first; native Copilot mirroring stays experimental.'
    };
  }
}
