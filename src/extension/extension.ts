import * as vscode from 'vscode';

import { PixelSquadViewProvider, VIEW_ID } from './PixelSquadViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PixelSquadViewProvider(context.extensionUri);

  const chatParticipant = vscode.chat.createChatParticipant('pixelSquad.orchestrator', async (request, chatContext, stream, token) => {
    void chatContext;
    const summary = await provider.createTaskFromPrompt(request.prompt, request.model, token);
    stream.markdown([
      'Pixel Squad routed your task and updated the Agent Factory panel.',
      '',
      summary,
      '',
      'Open the Pixel Squad panel to inspect rooms, agent assignments, and the task wall.'
    ].join('\n'));
  });
  chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.svg');
  chatParticipant.followupProvider = {
    provideFollowups: () => [
      {
        label: 'Break this into frontend and backend tasks',
        prompt: 'Break this into frontend and backend tasks for Pixel Squad.',
      },
      {
        label: 'Add a tester pass',
        prompt: 'Add a tester validation pass and update the Pixel Squad task wall.',
      },
    ]
  };

  context.subscriptions.push(
    chatParticipant,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('pixelSquad.showFactory', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('pixelSquad.openInEditor', () => {
      provider.openAsEditorPanel();
    }),
    vscode.commands.registerCommand('pixelSquad.createTask', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Describe the task you want Pixel Squad to route',
        placeHolder: 'Build the settings screen and persist the theme selection',
        ignoreFocusOut: true,
      });
      if (!prompt) {
        return;
      }

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.createTaskFromPrompt(prompt);
      void vscode.window.showInformationMessage(summary);
    }),
    vscode.commands.registerCommand('pixelSquad.resetWorkspace', async () => {
      provider.resetWorkspace();
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('pixelSquad.runSmokeTest', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.runSmokeTest();
      void vscode.window.showInformationMessage(summary);
    }),
    vscode.commands.registerCommand('pixelSquad.toggleAutoExecute', async () => {
      const config = vscode.workspace.getConfiguration('pixelSquad');
      const current = config.get<boolean>('autoExecute', false);
      await config.update('autoExecute', !current, vscode.ConfigurationTarget.Workspace);
      provider.refresh();
      void vscode.window.showInformationMessage(`Pixel Squad auto-execute: ${!current ? 'ON' : 'OFF'}`);
    }),
    vscode.commands.registerCommand('pixelSquad.createRoom', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      void vscode.window.showInformationMessage('Use the Agent Factory panel to create a room.');
    }),
    vscode.commands.registerCommand('pixelSquad.spawnAgent', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      void vscode.window.showInformationMessage('Use the Agent Factory panel to spawn an agent.');
    }),

    /* ── CLI: Assign Task to Agent ────────────────── */
    vscode.commands.registerCommand('pixelSquad.assignTask', async () => {
      const agents = provider.getAgents();
      if (agents.length === 0) {
        void vscode.window.showWarningMessage('No agents available. Spawn agents first.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        agents.map((a) => ({
          label: `$(person) ${a.name}`,
          description: `${a.provider} · ${a.status}`,
          detail: a.persona,
          agentId: a.id,
        })),
        { placeHolder: 'Pick an agent to assign a task to', matchOnDescription: true },
      );
      if (!pick) return;

      const prompt = await vscode.window.showInputBox({
        prompt: `Describe the task for ${pick.label.replace('$(person) ', '')}`,
        placeHolder: 'e.g. Write unit tests for the auth module',
        ignoreFocusOut: true,
      });
      if (!prompt) return;

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.assignTaskToAgent(pick.agentId, prompt);
      void vscode.window.showInformationMessage(summary);
    }),

    /* ── CLI: Fleet Execute ─────────────────────── */
    vscode.commands.registerCommand('pixelSquad.fleetExecute', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Describe the task to send to ALL idle agents simultaneously',
        placeHolder: 'e.g. Refactor the authentication module',
        ignoreFocusOut: true,
      });
      if (!prompt) return;

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.fleetExecute(prompt);
      void vscode.window.showInformationMessage(summary);
    }),

    /* ── CLI: List Agents ─────────────────────────── */
    vscode.commands.registerCommand('pixelSquad.listAgents', async () => {
      const agents = provider.getAgents();
      if (agents.length === 0) {
        void vscode.window.showInformationMessage('No agents in the squad yet.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        agents.map((a) => ({
          label: `$(person) ${a.name}`,
          description: `${a.provider} · ${a.status}`,
          detail: a.persona,
          agentId: a.id,
        })),
        { placeHolder: 'Your Pixel Squad agents (pick to assign a task)', matchOnDescription: true },
      );
      if (!pick) return;

      // If they pick an agent, let them assign a task
      const prompt = await vscode.window.showInputBox({
        prompt: `Assign a task to ${pick.label.replace('$(person) ', '')}?`,
        placeHolder: 'Leave empty to cancel, or describe a task',
        ignoreFocusOut: true,
      });
      if (!prompt) return;

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.assignTaskToAgent(pick.agentId, prompt);
      void vscode.window.showInformationMessage(summary);
    }),

    /* ── Cleanup ──────────────────────────────────── */
    { dispose: () => provider.dispose() }
  );
}

export function deactivate(): void {
  // Provider cleanup is handled via context.subscriptions
}
