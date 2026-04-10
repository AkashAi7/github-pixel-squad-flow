# Pixel Squad

Pixel Squad is a VS Code extension scaffold for a pixel-art multi-agent workspace that can evolve toward GitHub-model orchestration and Claude Code session visualization.

## Current Slice

This bootstrap includes:
- A VS Code panel contribution named `Agent Factory`
- A typed extension host with an in-memory coordinator
- Shared workspace and protocol models
- Stub provider adapters for Claude and Copilot paths
- A React/Vite webview that renders rooms, agents, tasks, provider health, and an inspector

## Commands

```powershell
npm install
Set-Location .\webview-ui; npm install
Set-Location ..
npm run build
npm run typecheck
npm run package:vsix
```

## GitHub Release Flow

- Repository: https://github.com/AkashAi7/Pixel-Squad
- Pushes to `main` run the CI workflow.
- Pushing a tag like `v0.0.2` runs the `Release VSIX` workflow.
- The release workflow builds the extension, packages a `.vsix`, and attaches it to the matching GitHub Release.

The first release is available at:

- https://github.com/AkashAi7/Pixel-Squad/releases/tag/v0.0.1

## Next Slice

- Replace the Claude stub with terminal spawning and live session observation
- Persist room/task state under a project-local Pixel Squad folder
- Add extension-owned GitHub-model orchestration flows
- Evolve the room view into a true factory editor
