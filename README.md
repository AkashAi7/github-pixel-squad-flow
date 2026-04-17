# GitHub Pixel Squad Flow

GitHub Pixel Squad Flow is a VS Code extension for chat-first multi-agent orchestration that supports both **GitHub Copilot** and **Claude Code** language models inside VS Code.

## What's New in v1.0.0

- **Independent release line** — GitHub Pixel Squad Flow now publishes from its own clean release stream starting at `v1.0.0`.
- **Chat-first runtime orchestration** — GitHub Copilot Chat drives task routing while the extension visualizes active runs, agent lanes, transcripts, and pipeline progress.
- **Safer release workflow** — The repo now includes release guidance and a GitHub release helper that preserve proper markdown notes and avoid pushing unrelated legacy tags.

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

## Using GitHub Pixel Squad Flow

1. Open the `Agent Factory` panel from the GitHub Pixel Squad Flow view in the secondary sidebar.
2. Start a run from GitHub Copilot Chat with `@pixel-squad`.
3. Target a persona lane like `/lead`, `/frontend`, `/backend`, `/tester`, `/devops`, or `/designer`.
4. Watch the runtime panel update with the active run, engaged agents, and pipeline stages.
5. Click agents to inspect the active lane, transcript, outputs, and changed files.

When both Copilot and Claude models are available, tasks are dispatched to the provider assigned to the executing agent. If a model is unavailable, the extension falls back to deterministic local routing.

GitHub Pixel Squad Flow now auto-populates task context from the current workspace by default. New tasks capture:

- the active file and current editor selection
- open editor tabs
- local git status and branch
- a scored set of relevant workspace files

That auto-populated context is used during planning and execution review so tasks behave closer to an agent-mode workflow.

Review cards now include a diff-style preview for proposed file edits before approval, so the task wall acts more like a lightweight patch review surface instead of only listing filenames and summaries.

When a task suggests terminal commands, running them now captures stdout, stderr, exit code, and duration back into the task review card instead of only sending the commands to a terminal.

## Settings

| Setting | Default | Description |
|---|---|---|
| `pixelSquad.autoExecute` | `false` | Auto-execute tasks after routing |
| `pixelSquad.modelFamily` | `copilot` | Preferred model family (`copilot` or `claude`) |
| `pixelSquad.autoPopulateWorkspaceContext` | `true` | Automatically capture active editor, open tabs, git state, and relevant files for each task |
| `pixelSquad.workspaceContextMaxFiles` | `3` | Maximum number of workspace files auto-included as context |

## Smoke Test

1. Press `F5` to launch the Extension Development Host.
2. Open the `Agent Factory` panel.
3. Run `GitHub Pixel Squad Flow: Run Smoke Test` from the Command Palette.
4. Verify rooms, agents, task routing, and pixel sprites render correctly.
5. Optionally try `@pixel-squad` in Copilot Chat.

## Automated E2E Smoke Test

Run `npm run test:e2e` to launch a real VS Code Extension Development Host with GitHub Pixel Squad Flow loaded into a temporary workspace.

The suite verifies:

- extension activation and command registration
- `pixelSquad.showFactory` command execution in the real host
- `pixelSquad.toggleAutoExecute` workspace setting updates
- `pixelSquad.runSmokeTest` mutating the real persisted `.pixel-squad/project.json`
- `pixelSquad.resetWorkspace` restoring the default snapshot deterministically

## Recordable Host E2E Demo

Run `npm run demo:e2e:record` to launch the real VS Code Extension Development Host visibly and drive GitHub Pixel Squad Flow through actual in-session commands.

The recordable flow:

- opens the real Extension Development Host
- runs `GitHub Pixel Squad Flow: Show Agent Factory`
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
