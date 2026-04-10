import * as vscode from 'vscode';

import type { SquadAgent, TaskCard, WorkspaceSnapshot } from '../../shared/model/index.js';
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

  async createTask(prompt: string, model?: vscode.LanguageModelChat, token?: vscode.CancellationToken): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'Pixel Squad ignored an empty task request.';
    }

    const plan = await this.copilot.createPlan(normalizedPrompt, this.snapshot.personas, model, token);
    const updatedAgents = [...this.snapshot.agents];
    const newTasks: TaskCard[] = [];

    for (const [index, assignment] of plan.assignments.entries()) {
      const agent = updatedAgents.find((item) => item.personaId === assignment.personaId)
        ?? updatedAgents.find((item) => item.personaId === 'lead');
      if (!agent) {
        continue;
      }

      const refreshedAgent: SquadAgent = {
        ...agent,
        provider: assignment.personaId === 'backend' || assignment.personaId === 'tester' ? 'claude' : 'copilot',
        status: index === 0 ? 'executing' : 'planning',
        summary: assignment.detail,
      };
      updatedAgents[updatedAgents.findIndex((item) => item.id === agent.id)] = refreshedAgent;
      newTasks.push({
        id: this.makeId('task'),
        title: assignment.title,
        status: index === 0 ? 'active' : 'queued',
        assigneeId: refreshedAgent.id,
        provider: refreshedAgent.provider,
        source: 'factory',
        detail: assignment.detail,
      });
    }

    this.snapshot = {
      ...this.snapshot,
      agents: updatedAgents,
      tasks: [...newTasks, ...this.snapshot.tasks].slice(0, 12),
      providers: [this.claude.getHealth(), this.copilot.getHealth()],
      activityFeed: [
        `Task received: ${plan.title}`,
        plan.providerDetail,
        ...this.snapshot.activityFeed,
      ].slice(0, 10),
    };
    this.store.save(this.snapshot);

    return `${plan.summary} ${plan.providerDetail}`;
  }

  resetWorkspace(): void {
    this.snapshot = this.loadSnapshot();
    this.store.save(this.snapshot);
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

  private makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }
}
