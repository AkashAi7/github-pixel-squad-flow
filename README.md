# Pixel Squad

Pixel Squad is a VS Code extension for a multi-agent orchestrating pixel factory that supports both **GitHub Copilot** and **Claude Code** language models inside VS Code.

## What's New in v0.1.4

- **Animated Room Stage** — Agents wander inside each room instead of sitting in a dense static grid.
- **Compact Status Badges** — Mood and provider emoji no longer overlap names or thought bubbles.
- **Pixel-Agents Style Motion** — Agents now shift position and direction over time for a livelier factory floor.
- **E2E Smoke Coverage** — Added an extension-host smoke suite for activation, routing, and reset flows.

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

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/Pixel-Squad
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v0.1.4` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the GitHub Release.
