# Pixel Squad

Pixel Squad is a VS Code extension for a multi-agent orchestrating pixel factory that supports both **GitHub Copilot** and **Claude Code** language models inside VS Code.

## What's New in v0.1.0

- **Dual-provider support** — Route tasks through GitHub Copilot or Claude.
- **Room CRUD** — Create themed rooms (frontend, backend, devops, testing, design, general) and delete them.
- **Agent Spawning** — Spawn pixel agents into rooms, choosing their persona and provider.
- **Pixel Character Sprites** — MetroCity-inspired CSS pixel art with 4 sprite variants and provider badges.
- **Room Theming** — Each room gets a colored left border and themed background.
- **Enhanced Stats** — Provider-split counters show Copilot vs Claude agent counts.

## Commands

```powershell
npm install
Set-Location .\webview-ui; npm install
Set-Location ..
npm run build
npm run typecheck
npm run package:vsix
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

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/Pixel-Squad
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v0.1.0` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the GitHub Release.
