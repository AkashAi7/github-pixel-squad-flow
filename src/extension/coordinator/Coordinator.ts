import type { WorkspaceSnapshot } from '../../shared/model/index.js';
import type { ActivityMessage } from '../../shared/protocol/messages.js';
import { EventBus } from './EventBus.js';
import { ClaudeAdapter } from '../providers/claude/ClaudeAdapter.js';
import { CopilotAdapter } from '../providers/copilot/CopilotAdapter.js';
import { ProjectStateStore } from '../persistence/ProjectStateStore.js';

export class Coordinator {
  private readonly claude = new ClaudeAdapter();
  private readonly copilot = new CopilotAdapter();
  private readonly store: ProjectStateStore;
  private snapshot: WorkspaceSnapshot;
  readonly activityBus = new EventBus<ActivityMessage>();

  constructor(rootPath?: string) {
    this.store = new ProjectStateStore(rootPath);
    this.snapshot = this.loadSnapshot();
  }

  getSnapshot(): WorkspaceSnapshot {
    return this.snapshot;
  }

  notifyWebviewConnected(): void {
    this.appendActivity('Factory panel connected to coordinator.');
  }

  selectAgent(agentId: string): void {
    this.appendActivity(`Inspector focused on ${agentId}.`);
  }

  private loadSnapshot(): WorkspaceSnapshot {
    const snapshot = this.store.load();
    return {
      ...snapshot,
      providers: [this.claude.getHealth(), this.copilot.getHealth()]
    };
  }

  private appendActivity(message: string): void {
    this.snapshot = {
      ...this.snapshot,
      providers: [this.claude.getHealth(), this.copilot.getHealth()],
      activityFeed: [message, ...this.snapshot.activityFeed].slice(0, 10)
    };
    this.store.save(this.snapshot);
    this.activityBus.publish({
      type: 'activity',
      message
    });
  }
}
