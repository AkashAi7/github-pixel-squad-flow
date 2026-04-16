import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const repoRoot = path.resolve('.');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-squad-e2e-'));
const extensionDevelopmentPath = path.join(runtimeRoot, 'extension-dev');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'test', 'e2e', 'suite', 'index.cjs');
const workspaceRoot = path.join(runtimeRoot, 'workspace');
const userDataDir = path.join(runtimeRoot, 'user-data');
const extensionsDir = path.join(runtimeRoot, 'extensions');
const cachePath = path.join(runtimeRoot, 'vscode-cache');
const vscodeVersion = '1.115.0';
const vscodeExecutableCandidates = [
  process.env.VSCODE_EXECUTABLE,
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft VS Code', 'Code.exe'),
];

function hasUpdateMarkers(installRoot) {
  return [
    'updating_version',
    'new_Code.exe',
    'new_Code.VisualElementsManifest.xml',
  ].some((name) => fs.existsSync(path.join(installRoot, name)));
}

function scrubUpdateMarkers(installRoot) {
  for (const name of ['updating_version', 'new_Code.exe', 'new_Code.VisualElementsManifest.xml']) {
    fs.rmSync(path.join(installRoot, name), { force: true });
  }
}

fs.symlinkSync(repoRoot, extensionDevelopmentPath, 'junction');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(extensionsDir, { recursive: true });
fs.mkdirSync(cachePath, { recursive: true });

const localVsCodeExecutablePath = vscodeExecutableCandidates.find((candidate) => {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }

  return !hasUpdateMarkers(path.dirname(candidate));
});

const vscodeExecutablePath = localVsCodeExecutablePath
  ?? await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath });

if (!localVsCodeExecutablePath) {
  scrubUpdateMarkers(path.dirname(vscodeExecutablePath));
}

try {
  await runTests({
    vscodeExecutablePath,
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