# Pixel Squad

Pixel Squad is a VS Code extension for a multi-agent orchestrating pixel factory that supports both **GitHub Copilot** and **Claude Code** language models inside VS Code.

## What's New in v0.1.5

- **Dependency-Aware Task Routing** — Routed work now carries dependency links, skill requirements, and progress labels from both live planners and deterministic fallback planning.
- **Structured Task Wall** — The webview groups and filters work by status or agent, shows progress bars, and exposes dependency context directly in the board.
- **Categorized Activity Feed** — Coordinator activity is now stored as typed events, making provider, agent, task, and system updates easier to scan.
- **Recordable Host Demo** — Added a visible `demo:e2e:record` flow that drives the real VS Code Extension Development Host for demos and release capture.

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

## Using Pixel Squad

1. Open the `Agent Factory` panel (Pixel Squad tab in the bottom panel).
2. **Create rooms** — Click `+ Room` and pick a theme.
3. **Spawn agents** — Click `+` on a room tile to spawn an agent with a persona and provider (Copilot or Claude).
4. **Route tasks** — Enter a task in the composer or use `@pixel-squad` in Copilot Chat.
5. **Manage agents** — Click agents to inspect, execute tasks, pause, resume, or retry.

When both Copilot and Claude models are available, tasks are dispatched to the provider assigned to the executing agent. If a model is unavailable, the extension falls back to deterministic local routing.

## Settings

| Setting | Default | Description |
|---|---|---|
| `pixelSquad.autoExecute` | `false` | Auto-execute tasks after routing |
| `pixelSquad.modelFamily` | `copilot` | Preferred model family (`copilot` or `claude`) |

## Smoke Test

1. Press `F5` to launch the Extension Development Host.
2. Open the `Agent Factory` panel.
3. Run `Pixel Squad: Run Smoke Test` from the Command Palette.
4. Verify rooms, agents, task routing, and pixel sprites render correctly.
5. Optionally try `@pixel-squad` in Copilot Chat.

## Automated E2E Smoke Test

Run `npm run test:e2e` to launch a real VS Code Extension Development Host with Pixel Squad loaded into a temporary workspace.

The suite verifies:

- extension activation and command registration
- `pixelSquad.showFactory` command execution in the real host
- `pixelSquad.toggleAutoExecute` workspace setting updates
- `pixelSquad.runSmokeTest` mutating the real persisted `.pixel-squad/project.json`
- `pixelSquad.resetWorkspace` restoring the default snapshot deterministically

## Recordable Host E2E Demo

Run `npm run demo:e2e:record` to launch the real VS Code Extension Development Host visibly and drive Pixel Squad through actual in-session commands.

The recordable flow:

- opens the real Extension Development Host
- runs `Pixel Squad: Show Agent Factory`
- runs `Pixel Squad: Create Routed Task` through the real extension command flow inside the host
- runs `Pixel Squad: Assign Task to Agent` through the real extension command flow inside the host
- verifies the persisted `.pixel-squad/project.json` state mutated correctly

Use `PIXEL_SQUAD_RECORD_HOLD_MS=20000 npm run demo:e2e:record` if you want the host window to stay open longer for recording.
Use `PIXEL_SQUAD_RECORD_STEP_DELAY_MS=2500 npm run demo:e2e:record` if you want slower pacing between steps.

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/Pixel-Squad
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v0.1.4` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the GitHub Release.
