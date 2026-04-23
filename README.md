# Pixel Squad Flow

Pixel Squad Flow is a VS Code extension for chat-first multi-agent orchestration that supports both **GitHub Copilot** and **Claude Code** language models inside VS Code.

## What's New in v1.3.1

- **Hybrid Copilot runtime** — Copilot-backed agents can plan through the GitHub Copilot SDK while keeping Pixel Crew’s run state, UI, and orchestration in extension code.
- **Agent Journal and Crew Chat visibility** — The runtime now exposes per-agent journals and inter-agent room chatter so you can see what each teammate did, touched, and said.
- **Plan-to-lane split routing fix** — Requests that ask for a plan and then downstream frontend/backend/tester task creation now split into the intended lanes instead of stalling on a single lead planning task.
- **Chat-first control surface** — `@pixel-squad` flows, room provisioning, lane follow-ups, work logs, and team prompts remain the primary UX rather than a command-palette-first workflow.

## Commands

```powershell
npm install
Set-Location .\webview-ui; npm install
Set-Location ..
npm run build
npm run typecheck
npm run package:vsix
npm run test:e2e
```

## Using Pixel Squad Flow

1. Open the `Agent Factory` panel from the Pixel Squad Flow view in the secondary sidebar.
2. Start a run from GitHub Copilot Chat with `@pixel-squad`.
3. Target a persona lane like `/lead`, `/frontend`, `/backend`, `/tester`, `/devops`, or `/designer`.
4. Watch the runtime panel update with the active run, engaged agents, and pipeline stages.
5. Click `Ping` on any agent card to continue that lane in GitHub Copilot Chat, or click the agent to inspect its lane, transcript, outputs, and changed files.
6. Use `Create Room` and `Provision Agent` from the panel when you need more rooms or lanes.

When both Copilot and Claude models are available, tasks are dispatched to the provider assigned to the executing agent. If a model is unavailable, the extension falls back to deterministic local routing.

Pixel Squad Flow now auto-populates task context from the current workspace by default. New tasks capture:

- the active file and current editor selection
- open editor tabs
- local git status and branch
- a scored set of relevant workspace files

That auto-populated context is used during planning and execution review so tasks behave closer to an agent-mode workflow.

Review cards now include a diff-style preview for proposed file edits before approval, so the task wall acts more like a lightweight patch review surface instead of only listing filenames and summaries.

When a task suggests terminal commands, running them now captures stdout, stderr, exit code, and duration back into the task review card instead of only sending the commands to a terminal.

When an agent is active, the launchpad now shows a smaller `Continue lane` action and the selected agent channel still includes both `Open in Copilot Chat` and `Visualize Run`, so lane continuation and related-stage inspection stay reachable without dominating the runtime shell.

## Settings

| Setting | Default | Description |
|---|---|---|
| `pixelSquad.autoExecute` | `true` | Auto-execute tasks after routing |
| `pixelSquad.modelFamily` | `copilot` | Preferred model family (`copilot` or `claude`) |
| `pixelSquad.autoPopulateWorkspaceContext` | `true` | Automatically capture active editor, open tabs, git state, and relevant files for each task |
| `pixelSquad.workspaceContextMaxFiles` | `3` | Maximum number of workspace files auto-included as context |

## Smoke Test

1. Press `F5` to launch the Extension Development Host.
2. Open the `Agent Factory` panel.
3. Run `Pixel Squad Flow: Run Smoke Test` from the Command Palette.
4. Verify rooms, agents, task routing, and pixel sprites render correctly.
5. Optionally try `@pixel-squad` in Copilot Chat.

## Automated E2E Smoke Test

Run `npm run test:e2e` to launch a real VS Code Extension Development Host with Pixel Squad Flow loaded into a temporary workspace.

The suite verifies:

- extension activation and command registration
- `pixelSquad.showFactory` command execution in the real host
- `pixelSquad.toggleAutoExecute` workspace setting updates
- `pixelSquad.runSmokeTest` mutating the real persisted `.pixel-squad/project.json`
- `pixelSquad.resetWorkspace` restoring the default snapshot deterministically

## Recordable Host E2E Demo

Run `npm run demo:e2e:record` to launch the real VS Code Extension Development Host visibly and drive Pixel Squad Flow through actual in-session commands.

The recordable flow:

- opens the real Extension Development Host
- runs `Pixel Squad Flow: Show Agent Factory`
- runs the smoke-test and chat-first runtime flow inside the real extension host
- verifies the persisted `.pixel-squad/project.json` state mutated correctly

Use `PIXEL_SQUAD_RECORD_HOLD_MS=20000 npm run demo:e2e:record` if you want the host window to stay open longer for recording.
Use `PIXEL_SQUAD_RECORD_STEP_DELAY_MS=2500 npm run demo:e2e:record` if you want slower pacing between steps.

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/github-pixel-squad-flow
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v1.0.0` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the GitHub Release.
- Publish tags with `git push origin main --follow-tags` so only the current release tag is sent.
- When editing GitHub release notes manually, use a markdown file or real multiline input instead of escaped `\n` sequences.

## Release Helper

Use the built-in helper after packaging a release artifact:

```powershell
npm run package:vsix
npm run release:github -- 1.0.0 github-pixel-squad-flow.vsix
```
