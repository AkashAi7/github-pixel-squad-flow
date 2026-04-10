import type { ProviderHealth } from '../../shared/model/index.js';

export interface ProviderAdapter {
  readonly id: 'claude' | 'copilot';
  getHealth(): ProviderHealth;
}
