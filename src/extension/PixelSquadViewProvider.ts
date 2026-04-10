import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { Coordinator } from './coordinator/Coordinator.js';
import type { ExtensionMessage, WebviewMessage } from '../shared/protocol/messages.js';

export const VIEW_ID = 'pixelSquad.factoryView';

export class PixelSquadViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly coordinator: Coordinator;

  constructor(private readonly extensionUri: vscode.Uri) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.coordinator = new Coordinator(workspaceRoot);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(vscode.Uri.file(this.extensionUri.fsPath), 'dist', 'webview')
      ]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const unsubscribe = this.coordinator.activityBus.subscribe((message) => {
      this.postMessage(message);
    });

    webviewView.onDidDispose(() => {
      unsubscribe();
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'webviewReady') {
        this.coordinator.notifyWebviewConnected();
        this.postMessage({
          type: 'bootstrapState',
          snapshot: this.coordinator.getSnapshot()
        });
      }

      if (message.type === 'showAgent') {
        this.coordinator.selectAgent(message.agentId);
      }
    });
  }

  private postMessage(message: ExtensionMessage): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const webviewDist = path.join(this.extensionUri.fsPath, 'dist', 'webview');
    const htmlPath = path.join(webviewDist, 'index.html');

    if (!fs.existsSync(htmlPath)) {
      return this.getFallbackHtml(webview);
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const assetBase = webview.asWebviewUri(vscode.Uri.file(webviewDist)).toString();
    const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource}; connect-src ${webview.cspSource};`;

    return html
      .replace(/<head>/, `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replaceAll('src="./', `src="${assetBase}/`)
      .replaceAll('href="./', `href="${assetBase}/`);
  }

  private getFallbackHtml(webview: vscode.Webview): string {
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pixel Squad</title>
    <style>
      body { font-family: sans-serif; padding: 24px; background: #101820; color: #f7f3e9; }
      strong { color: #ffe066; }
    </style>
  </head>
  <body>
    <strong>Pixel Squad webview has not been built yet.</strong>
    <p>Run the webview build to replace this fallback with the factory UI.</p>
  </body>
</html>`;
  }
}
