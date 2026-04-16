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
        ? `GitHub Pixel Squad Flow synced your chat request to the ${selectedPersona} agent lane and updated the runtime panel.`
        : 'GitHub Pixel Squad Flow routed your chat request and updated the runtime panel.',
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
        prompt: 'Break this into frontend and backend tasks for GitHub Pixel Squad Flow.',
      },
      {
        label: 'Add a tester pass',
        prompt: 'Add a tester validation pass and update the GitHub Pixel Squad Flow task wall.',
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
        prompt: 'Describe the task you want GitHub Pixel Squad Flow to route',
        placeHolder: 'Break this feature into agent stages and track the pipeline',
        ignoreFocusOut: true,
      });
      if (!prompt) {
        return;
      }

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.createTaskFromPrompt(prompt);
      void vscode.window.showInformationMessage(summary);
    }),
    vscode.commands.registerCommand('pixelSquad.openInEditor', () => {
      provider.openAsEditorPanel();
    }),
    vscode.commands.registerCommand('pixelSquad.assignTask', async () => {
      const agents = provider.getAgents();
      if (agents.length === 0) {
        void vscode.window.showWarningMessage('No agents are available yet. Start a run from chat first or use the smoke test to seed the board.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        agents.map((agent) => ({
          label: `$(person) ${agent.name}`,
          description: `${agent.provider} · ${agent.status}`,
          detail: agent.persona,
          agentId: agent.id,
        })),
        { placeHolder: 'Pick an agent lane to assign work to', matchOnDescription: true },
      );
      if (!pick) {
        return;
      }

      const prompt = await vscode.window.showInputBox({
        prompt: `Describe the task for ${pick.label.replace('$(person) ', '')}`,
        placeHolder: 'Review the latest UI flow and report blockers',
        ignoreFocusOut: true,
      });
      if (!prompt) {
        return;
      }

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.assignTaskToAgent(pick.agentId, prompt);
      void vscode.window.showInformationMessage(summary);
    }),
    vscode.commands.registerCommand('pixelSquad.listAgents', async () => {
      const agents = provider.getAgents();
      if (agents.length === 0) {
        void vscode.window.showInformationMessage('No agent lanes are active yet.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        agents.map((agent) => ({
          label: `$(person) ${agent.name}`,
          description: `${agent.provider} · ${agent.status}`,
          detail: agent.persona,
          agentId: agent.id,
        })),
        { placeHolder: 'Active GitHub Pixel Squad Flow agent lanes', matchOnDescription: true },
      );
      if (!pick) {
        return;
      }

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.refresh();
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
    vscode.commands.registerCommand('pixelSquad.fleetExecute', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Describe the task to send across all idle agents',
        placeHolder: 'Audit the current implementation and summarize issues by persona',
        ignoreFocusOut: true,
      });
      if (!prompt) {
        return;
      }

      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      const summary = await provider.fleetExecute(prompt);
      void vscode.window.showInformationMessage(summary);
    }),
    vscode.commands.registerCommand('pixelSquad.toggleAutoExecute', async () => {
      const config = vscode.workspace.getConfiguration('pixelSquad');
      const current = config.get<boolean>('autoExecute', false);
      await config.update('autoExecute', !current, vscode.ConfigurationTarget.Workspace);
      provider.refresh();
      void vscode.window.showInformationMessage(`GitHub Pixel Squad Flow auto-execute: ${!current ? 'ON' : 'OFF'}`);
    }),

    /* ── Cleanup ──────────────────────────────────── */
    { dispose: () => provider.dispose() }
  );
}

export function deactivate(): void {
  // Provider cleanup is handled via context.subscriptions
}
