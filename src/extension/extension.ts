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
    })
  );
}

export function deactivate(): void {}
