import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WorkspaceSnapshot } from '../../shared/model/index.js';
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
      return JSON.parse(raw) as WorkspaceSnapshot;
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

  private getFilePath(): string {
    return path.join(this.rootPath ?? '.', '.pixel-squad', 'project.json');
  }
}
