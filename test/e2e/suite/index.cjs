const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vscode = require('vscode');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function hasTaskMetadata(task) {
  return Array.isArray(task.dependsOn)
    && Array.isArray(task.requiredSkillIds)
    && task.progress
    && typeof task.progress.value === 'number'
    && typeof task.progress.total === 'number'
    && typeof task.progress.label === 'string';
}

async function run() {
  const extension = vscode.extensions.getExtension('akashai7.pixel-squad');
  assert.ok(extension, 'Expected Pixel Squad extension to be installed in the test host.');

  await extension.activate();
  assert.equal(extension.isActive, true, 'Expected Pixel Squad extension to activate.');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('pixelSquad.showFactory'), 'Expected showFactory command to be registered.');
  assert.ok(commands.includes('pixelSquad.runSmokeTest'), 'Expected runSmokeTest command to be registered.');

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(workspaceFolder, 'Expected a test workspace folder.');

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const snapshotPath = path.join(workspaceRoot, '.pixel-squad', 'project.json');

  const baseline = await poll(() => {
    if (!fs.existsSync(snapshotPath)) {
      return undefined;
    }

    const snapshot = readSnapshot(snapshotPath);
    if (snapshot.projectName === 'Pixel Squad') {
      return snapshot;
    }

    return undefined;
  });

  assert.equal(baseline.rooms.length, 3, 'Expected default rooms in the baseline snapshot.');
  assert.equal(baseline.agents.length, 4, 'Expected default agents in the baseline snapshot.');
  assert.equal(baseline.tasks.length, 3, 'Expected default tasks in the baseline snapshot.');

  await vscode.commands.executeCommand('pixelSquad.showFactory');

  const createTaskPrompt = 'Build a release notes panel and persist dismissed announcements.';

  await withStubbedWindowPrompts({
    showInputBox: async () => createTaskPrompt,
  }, async () => {
    await vscode.commands.executeCommand('pixelSquad.createTask');
  });

  const routedSnapshot = await poll(() => {
    const snapshot = readSnapshot(snapshotPath);
    const hasRoutedEffects = snapshot.tasks.length > baseline.tasks.length
      && activityIncludes(snapshot.activityFeed, 'Task received:');

    if (!hasRoutedEffects) {
      return undefined;
    }

    return snapshot;
  });

  assert.ok(
    activityIncludes(routedSnapshot.activityFeed, 'Task received:'),
    'Expected createTask command to update the activity feed.',
  );
  assert.ok(
    routedSnapshot.tasks.length > baseline.tasks.length,
    'Expected createTask command to persist routed tasks.',
  );
  assert.ok(
    routedSnapshot.tasks.slice(0, routedSnapshot.tasks.length - baseline.tasks.length).every(hasTaskMetadata),
    'Expected routed tasks to include dependency, skill, and progress metadata.',
  );

  await vscode.commands.executeCommand('pixelSquad.toggleAutoExecute');
  await poll(() => {
    const autoExecute = vscode.workspace.getConfiguration('pixelSquad').get('autoExecute');
    return autoExecute === false ? true : undefined;
  });

  await vscode.commands.executeCommand('pixelSquad.runSmokeTest');

  const smokeSnapshot = await poll(() => {
    const snapshot = readSnapshot(snapshotPath);
    const hasSmokeEffects = snapshot.tasks.length > baseline.tasks.length
      && activityIncludes(snapshot.activityFeed, 'Task received:');

    return hasSmokeEffects ? snapshot : undefined;
  });

  assert.ok(
    activityIncludes(smokeSnapshot.activityFeed, 'Task received:'),
    'Expected smoke test to update the activity feed.',
  );
  assert.ok(
    smokeSnapshot.tasks.length > baseline.tasks.length,
    'Expected smoke test to add routed tasks to the snapshot.',
  );
  assert.ok(
    smokeSnapshot.tasks.slice(0, smokeSnapshot.tasks.length - baseline.tasks.length).every(hasTaskMetadata),
    'Expected smoke test tasks to carry metadata for progress and dependency-aware scheduling.',
  );

  await vscode.commands.executeCommand('pixelSquad.resetWorkspace');

  const resetSnapshot = await poll(() => {
    const snapshot = readSnapshot(snapshotPath);
    const isReset = snapshot.tasks.length === 3
      && snapshot.rooms.length === 3
      && snapshot.agents.length === 4
      && snapshot.tasks.every((task) => task.status === 'done');

    return isReset ? snapshot : undefined;
  });

  assert.equal(resetSnapshot.projectName, 'Pixel Squad', 'Expected reset to restore the default project name.');
  assert.equal(resetSnapshot.settings.autoExecute, false, 'Expected reset snapshot to preserve current workspace settings.');
}

module.exports = {
  run,
};