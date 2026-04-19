import * as fs from 'node:fs';
import * as path from 'node:path';

import { createActivityEntry, type ActivityEntry, type PersonaTemplate, type TaskCard, type TaskProgress, type TaskStatus, type WorkspaceSnapshot } from '../../shared/model/index.js';
import { createDefaultSnapshot } from './defaultSnapshot.js';

export class ProjectStateStore {
  constructor(private readonly rootPath: string | undefined) {}

  load(): WorkspaceSnapshot {
    if (!this.rootPath) {
      return createDefaultSnapshot();
    }

    const filePath = this.getFilePath();
    if (!fs.existsSync(filePath)) {
      const snapshot = createDefaultSnapshot();
      this.save(snapshot);
      return snapshot;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return this.normalizeSnapshot(JSON.parse(raw) as Partial<WorkspaceSnapshot> & {
        activityFeed?: Array<ActivityEntry | string>;
      });
    } catch {
      const snapshot = createDefaultSnapshot();
      this.save(snapshot);
      return snapshot;
    }
  }

  save(snapshot: WorkspaceSnapshot): void {
    if (!this.rootPath) {
      return;
    }

    const filePath = this.getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }

  /** Non-blocking variant — fire-and-forget async write. */
  saveAsync(snapshot: WorkspaceSnapshot): void {
    if (!this.rootPath) {
      return;
    }

    const filePath = this.getFilePath();
    const data = `${JSON.stringify(snapshot, null, 2)}\n`;
    void fs.promises.mkdir(path.dirname(filePath), { recursive: true }).then(() =>
      fs.promises.writeFile(filePath, data, 'utf8'),
    );
  }

  reset(): WorkspaceSnapshot {
    const snapshot = createDefaultSnapshot();
    this.save(snapshot);
    return snapshot;
  }

  private getFilePath(): string {
    return path.join(this.rootPath ?? '.', '.pixel-squad', 'project.json');
  }

  private normalizeSnapshot(snapshot: Partial<WorkspaceSnapshot> & { activityFeed?: Array<ActivityEntry | string> }): WorkspaceSnapshot {
    const fallback = createDefaultSnapshot();
    const personaDefaults = new Map(fallback.personas.map((persona) => [persona.id, persona]));

    return {
      projectName: snapshot.projectName ?? fallback.projectName,
      rooms: snapshot.rooms ?? fallback.rooms,
      personas: (snapshot.personas ?? fallback.personas).map((persona) => this.normalizePersona(persona, personaDefaults)),
      agents: snapshot.agents ?? fallback.agents,
      tasks: (snapshot.tasks ?? fallback.tasks).map((task) => this.normalizeTask(task)),
      runs: snapshot.runs ?? fallback.runs,
      agentSessions: snapshot.agentSessions ?? fallback.agentSessions,
      providers: snapshot.providers ?? fallback.providers,
      activityFeed: this.normalizeActivityFeed(snapshot.activityFeed ?? fallback.activityFeed),
      roomFeeds: snapshot.roomFeeds ?? fallback.roomFeeds ?? {},
      settings: {
        ...fallback.settings,
        ...snapshot.settings,
      },
      ui: {
        ...fallback.ui,
        ...snapshot.ui,
      },
    };
  }

  private normalizePersona(persona: PersonaTemplate, personaDefaults: Map<string, PersonaTemplate>): PersonaTemplate {
    const fallback = personaDefaults.get(persona.id);
    return {
      ...fallback,
      ...persona,
      skills: persona.skills ?? fallback?.skills ?? [],
    };
  }

  private normalizeTask(task: TaskCard): TaskCard {
    const createdAt = task.createdAt ?? Date.now();
    return {
      ...task,
      dependsOn: task.dependsOn ?? [],
      requiredSkillIds: task.requiredSkillIds ?? [],
      workspaceContext: task.workspaceContext,
      executionPlan: task.executionPlan
        ? {
            ...task.executionPlan,
            commandResults: task.executionPlan.commandResults ?? [],
          }
        : undefined,
      approvalState: task.approvalState,
      progress: task.progress ?? this.progressForStatus(task.status),
      createdAt,
      updatedAt: task.updatedAt ?? createdAt,
    };
  }

  private normalizeActivityFeed(feed: Array<ActivityEntry | string>): ActivityEntry[] {
    const now = Date.now();
    return feed.map((entry, index) => {
      if (typeof entry === 'string') {
        return createActivityEntry(entry, 'system', {
          id: `activity-legacy-${index}`,
          timestamp: now - index,
        });
      }

      return {
        ...entry,
        id: entry.id ?? `activity-${now}-${index}`,
        category: entry.category ?? 'system',
        timestamp: entry.timestamp ?? now - index,
      };
    });
  }

  private progressForStatus(status: TaskStatus): TaskProgress {
    switch (status) {
      case 'queued':
        return { value: 0, total: 3, label: 'Queued' };
      case 'active':
        return { value: 1, total: 3, label: 'Executing' };
      case 'review':
        return { value: 2, total: 3, label: 'Review' };
      case 'done':
        return { value: 3, total: 3, label: 'Complete' };
      case 'failed':
        return { value: 3, total: 3, label: 'Failed' };
    }
  }
}
