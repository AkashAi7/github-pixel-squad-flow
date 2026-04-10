import * as vscode from 'vscode';

import { PixelSquadViewProvider, VIEW_ID } from './PixelSquadViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PixelSquadViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('pixelSquad.showFactory', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    })
  );
}

export function deactivate(): void {}
