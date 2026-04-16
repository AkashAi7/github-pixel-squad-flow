const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vscode = require('vscode');

const holdMs = Number.parseInt(process.env.PIXEL_SQUAD_RECORD_HOLD_MS ?? '12000', 10);
const stepDelayMs = Number.parseInt(process.env.PIXEL_SQUAD_RECORD_STEP_DELAY_MS ?? '1800', 10);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(check, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function readSnapshot(snapshotPath) {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function activityIncludes(activityFeed, text) {
  return activityFeed.some((entry) => {
    if (typeof entry === 'string') {
      return entry.includes(text);
    }

    return typeof entry?.message === 'string' && entry.message.includes(text);
  });
}

async function withStubbedWindowPrompts(stubs, run) {
  const originalShowInputBox = vscode.window.showInputBox;
  const originalShowQuickPick = vscode.window.showQuickPick;

  if (stubs.showInputBox) {
    vscode.window.showInputBox = stubs.showInputBox;
  }

  if (stubs.showQuickPick) {
    vscode.window.showQuickPick = stubs.showQuickPick;
  }

  try {
    return await run();
  } finally {
    vscode.window.showInputBox = originalShowInputBox;
    vscode.window.showQuickPick = originalShowQuickPick;
  }
}

async function announce(message) {
  void vscode.window.showInformationMessage(message);
  await delay(stepDelayMs);
}

async function run() {
  const extension = vscode.extensions.getExtension('akashai7.pixel-squad');
  assert.ok(extension, 'Expected Pixel Squad extension to be installed in the record host.');

  await extension.activate();
  assert.equal(extension.isActive, true, 'Expected Pixel Squad extension to activate.');

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(workspaceFolder, 'Expected a test workspace folder.');

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const snapshotPath = path.join(workspaceRoot, '.pixel-squad', 'project.json');

  await announce('Pixel Squad recordable host demo is starting.');
  await vscode.commands.executeCommand('pixelSquad.showFactory');
  await delay(stepDelayMs);

  const baseline = await poll(() => {
    if (!fs.existsSync(snapshotPath)) {
      return undefined;
    }

    const snapshot = readSnapshot(snapshotPath);
    return snapshot.projectName === 'Pixel Squad' ? snapshot : undefined;
  });

  await announce('Routing a real task through Pixel Squad in the VS Code host.');
  const routedPrompt = 'Create a release readiness checklist and split the work across the squad.';
  await withStubbedWindowPrompts({
    showInputBox: async () => routedPrompt,
  }, async () => {
    await vscode.commands.executeCommand('pixelSquad.createTask');
  });

  await poll(() => {
    const snapshot = readSnapshot(snapshotPath);
    return snapshot.tasks.length > baseline.tasks.length
      && activityIncludes(snapshot.activityFeed, 'Task received:')
      ? snapshot
      : undefined;
  });

  await announce(`Recordable host demo complete. Holding the VS Code window for ${holdMs}ms.`);
  await delay(holdMs);
}

module.exports = {
  run,
};