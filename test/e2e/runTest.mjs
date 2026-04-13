import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTests } from '@vscode/test-electron';

const repoRoot = path.resolve('.');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-squad-e2e-'));
const extensionDevelopmentPath = path.join(runtimeRoot, 'extension-dev');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'test', 'e2e', 'suite', 'index.cjs');
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
      '--disable-extensions',
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
    ],
  });
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}