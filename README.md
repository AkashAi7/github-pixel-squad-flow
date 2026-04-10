# Pixel Squad

Pixel Squad is a VS Code extension for a pixel-art multi-agent workspace that currently supports extension-owned GitHub-model routing and is being extended toward Claude Code session visualization.

## Current Slice

This release includes:
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
- Or run `Pixel Squad: Run Smoke Test` to verify the full demo routing loop quickly.

When a GitHub Copilot chat model is available, Pixel Squad will use it to plan persona assignments. If not, it falls back to local routing heuristics and still updates the factory.

## Smoke Test

A smoke test is the fastest possible end-to-end verification that the product still basically works after a change.

For Pixel Squad, the smoke test is:

1. Launch the extension in an Extension Development Host with `F5` using `.vscode/launch.json`.
2. Open the `Agent Factory` panel.
3. Run `Pixel Squad: Run Smoke Test` from the Command Palette.
4. Confirm that the panel resets, routes a canned task, updates the pixel board, changes the task wall, and appends activity feed entries.
5. Optionally open Copilot Chat and try `@pixel-squad break this into frontend and backend tasks`.

If those steps work, the extension is healthy enough for a basic product sanity check.

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/Pixel-Squad
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v0.0.3` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the matching GitHub Release.

The latest release is available at:

- https://github.com/AkashAi7/Pixel-Squad/releases/tag/v0.0.2

## Next Slice

- Replace the Claude stub with terminal spawning and live session observation
- Evolve the current task router into multi-step task execution with richer room state
- Evolve the room view into a true factory editor
