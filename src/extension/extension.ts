import * as vscode from 'vscode';

import { PixelSquadViewProvider, VIEW_ID } from './PixelSquadViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PixelSquadViewProvider(context.extensionUri);
  const personaCommandMap = new Set(['lead', 'frontend', 'backend', 'tester', 'devops', 'designer']);

  const chatParticipant = vscode.chat.createChatParticipant('pixelSquad.orchestrator', async (request, chatContext, stream, token) => {
    void chatContext;
    const selectedPersona = request.command && personaCommandMap.has(request.command) ? request.command : undefined;
    const summary = selectedPersona
      ? await provider.assignTaskToPersona(selectedPersona, request.prompt, 'copilot', request.model, token)
      : await provider.createTaskFromPrompt(request.prompt, request.model, token);
    stream.markdown([
      selectedPersona
        ? `Pixel Squad synced your chat request to the ${selectedPersona} agent lane and updated the runtime panel.`
        : 'Pixel Squad routed your chat request and updated the runtime panel.',
      '',
      summary,
      '',
      selectedPersona
        ? 'Open the Pixel Squad panel to inspect the focused agent, pipeline state, execution output, and changed files.'
        : 'Open the Pixel Squad panel to inspect the active run, engaged agents, and pipeline state.'
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

    /* ── Cleanup ──────────────────────────────────── */
    { dispose: () => provider.dispose() }
  );
}

export function deactivate(): void {
  // Provider cleanup is handled via context.subscriptions
}
