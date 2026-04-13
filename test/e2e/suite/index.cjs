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
      && snapshot.activityFeed.some((message) => message.includes('Task received:'));

    if (!hasRoutedEffects) {
      return undefined;
    }

    return snapshot;
  });

  assert.ok(
    routedSnapshot.activityFeed.some((message) => message.includes('Task received:')),
    'Expected createTask command to update the activity feed.',
  );
  assert.ok(
    routedSnapshot.tasks.length > baseline.tasks.length,
    'Expected createTask command to persist routed tasks.',
  );

  const assignTaskPrompt = 'Audit the settings migration path and report any regressions.';

  await withStubbedWindowPrompts({
    showQuickPick: async (items) => items.find((item) => item.agentId === 'tester-1') ?? items[0],
    showInputBox: async () => assignTaskPrompt,
  }, async () => {
    await vscode.commands.executeCommand('pixelSquad.assignTask');
  });

  const assignedSnapshot = await poll(() => {
    const snapshot = readSnapshot(snapshotPath);
    const assignedTask = snapshot.tasks.find((task) => task.detail === assignTaskPrompt);
    const assignedAgent = snapshot.agents.find((agent) => agent.id === 'tester-1');

    if (!assignedTask || !assignedAgent) {
      return undefined;
    }

    if (assignedTask.assigneeId !== 'tester-1' || assignedTask.status !== 'active' || assignedAgent.status !== 'executing') {
      return undefined;
    }

    return { snapshot, assignedTask, assignedAgent };
  });

  assert.ok(
    assignedSnapshot.snapshot.activityFeed.some((message) => message.includes('Task assigned to Mica:')),
    'Expected assignTask command to persist assignment activity.',
  );

  await vscode.commands.executeCommand('pixelSquad.toggleAutoExecute');
  await poll(() => {
    const autoExecute = vscode.workspace.getConfiguration('pixelSquad').get('autoExecute');
    return autoExecute === true ? true : undefined;
  });

  await vscode.commands.executeCommand('pixelSquad.runSmokeTest');

  const smokeSnapshot = await poll(() => {
    const snapshot = readSnapshot(snapshotPath);
    const hasSmokeEffects = snapshot.tasks.length > baseline.tasks.length
      && snapshot.activityFeed.some((message) => message.includes('Task received:'));

    return hasSmokeEffects ? snapshot : undefined;
  });

  assert.ok(
    smokeSnapshot.activityFeed.some((message) => message.includes('Task received:')),
    'Expected smoke test to update the activity feed.',
  );
  assert.ok(
    smokeSnapshot.tasks.length > baseline.tasks.length,
    'Expected smoke test to add routed tasks to the snapshot.',
  );
  assert.ok(
    smokeSnapshot.agents.some((agent) => agent.status === 'executing' || agent.status === 'planning' || agent.status === 'waiting'),
    'Expected smoke test to update agent statuses.',
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
  assert.equal(resetSnapshot.settings.autoExecute, true, 'Expected reset snapshot to preserve current workspace settings.');
}

module.exports = {
  run,
};