# Pixel Squad

Pixel Squad is a VS Code extension scaffold for a pixel-art multi-agent workspace that can evolve toward GitHub-model orchestration and Claude Code session visualization.

## Current Slice

This bootstrap includes:
- A VS Code panel contribution named `Agent Factory`
- A typed extension host with a persisted coordinator
- Shared workspace and protocol models
- A real extension-owned GitHub-model planning path with deterministic fallback routing
- A React/Vite webview that renders rooms, agents, tasks, provider health, and an inspector
- A `@pixel-squad` chat participant for Copilot Chat-driven routing

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

- Open the `Agent Factory` panel.
- Enter a task in the factory composer and route it through the squad.
- Or use `Pixel Squad: Create Routed Task` from the Command Palette.
- Or open GitHub Copilot Chat and invoke `@pixel-squad` with a software task.

When a GitHub Copilot chat model is available, Pixel Squad will use it to plan persona assignments. If not, it falls back to local routing heuristics and still updates the factory.

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/Pixel-Squad
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v0.0.2` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the matching GitHub Release.

The first release is available at:

- https://github.com/AkashAi7/Pixel-Squad/releases/tag/v0.0.1

## Next Slice

- Replace the Claude stub with terminal spawning and live session observation
- Evolve the current task router into multi-step task execution with richer room state
- Evolve the room view into a true factory editor
