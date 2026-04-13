import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTests } from '@vscode/test-electron';

const repoRoot = path.resolve('.');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-squad-record-'));
const extensionDevelopmentPath = path.join(runtimeRoot, 'extension-dev');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'test', 'e2e', 'suite', 'record.cjs');
const workspaceRoot = path.join(runtimeRoot, 'workspace');
const userDataDir = path.join(runtimeRoot, 'user-data');
const extensionsDir = path.join(runtimeRoot, 'extensions');

fs.symlinkSync(repoRoot, extensionDevelopmentPath, 'junction');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(extensionsDir, { recursive: true });

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspaceRoot,
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      '--skip-welcome',
      '--disable-workspace-trust',
    ],
    extensionTestsEnv: {
      PIXEL_SQUAD_RECORD_HOLD_MS: process.env.PIXEL_SQUAD_RECORD_HOLD_MS ?? '12000',
      PIXEL_SQUAD_RECORD_STEP_DELAY_MS: process.env.PIXEL_SQUAD_RECORD_STEP_DELAY_MS ?? '1800',
    },
  });
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}