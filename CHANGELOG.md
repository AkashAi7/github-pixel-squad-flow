# Changelog

## 0.1.0

- Add dual-provider support: route tasks through **GitHub Copilot** or **Claude** language models.
- Add a full Claude adapter using `vscode.lm.selectChatModels` with vendor/family fallback.
- Add **Room CRUD**: create rooms with themes (frontend, backend, devops, testing, design, general) and delete rooms.
- Add **Agent Spawning**: spawn agents into rooms with persona selection and provider choice (Copilot or Claude).
- Add **MetroCity-inspired pixel character sprites**: CSS-drawn 3-part characters (head/body/legs) with 4 sprite variants and provider badges.
- Add CreateRoomDialog and SpawnAgentDialog modal components.
- Rewrite the FactoryBoard with room management buttons, theme-colored left borders, and pixel character tiles.
- Rewrite the App with provider stats (Copilot/Claude agent counts), room creation flow, and dual-provider task badges.
- Expand the default snapshot to 6 personas (added devops, designer) with mixed Copilot/Claude agents.
- Add `pixelSquad.createRoom` and `pixelSquad.spawnAgent` commands.
- Add `pixelSquad.modelFamily` enum setting with `copilot` and `claude` options.
- Increase activity feed to 20 items and task limit to 40.
- Major CSS overhaul: pixel characters, dialog overlays, theme/persona grids, provider toggles, icon buttons, responsive breakpoints.

## 0.0.5

- Fix webview panel not rendering by adding `"type": "webview"` to the view registration.
- Rewrite asset URL resolution to use per-file `asWebviewUri()` (matching pixel-agents approach).
- Strip Vite's `crossorigin` attributes that break in webview context.
- Remove overly restrictive CSP that was blocking module script loading.

## 0.0.4

- Make Pixel Squad a fully GitHub Copilot-native product — remove all Claude adapter code and references.
- Add agent lifecycle management with pause, resume, complete, and retry state transitions.
- Add a task execution engine that sends work to GitHub Copilot models with deterministic fallback.
- Add task controls in the webview: Execute, Approve, Reject, Retry, and Re-open.
- Add agent controls in the inspector panel: Pause, Resume, Complete, and Retry.
- Add expandable task output display with monospace rendering.
- Add stats bar showing total, active, done, and failed task counts.
- Add status badges with color coding for all agent and task states.
- Add `pixelSquad.autoExecute` and `pixelSquad.modelFamily` settings.
- Add `Pixel Squad: Toggle Auto-Execute` command.
- Add a 5-step onboarding walkthrough (Get Started with Pixel Squad).
- Add executing-agent pulse animation on pixel sprites.

## 0.0.3

- Add a visible pixel-style factory board so the workspace feels closer to a live agent floor.
- Add `Pixel Squad: Run Smoke Test` for a fast end-to-end sanity check inside the Extension Development Host.
- Add `.vscode` launch/tasks configs for one-click local testing.
- Clean up release metadata and packaging by syncing webview versioning, fixing stale docs, and excluding dev-only VS Code files from the shipped VSIX.

## 0.0.2

- Add an end-to-end Pixel Squad task routing flow from the panel, command palette, and `@pixel-squad` chat participant.
- Add GitHub-model planning through the VS Code language model API with deterministic fallback routing when no Copilot model is available.
- Update the factory UI with a task composer, provider availability states, and live task-wall refresh.
- Persist routed tasks and agent state through the project-local Pixel Squad snapshot.

## 0.0.1

- Bootstrap Pixel Squad as a VS Code extension with an Agent Factory panel.
- Add shared squad/task/room models and typed host-webview messaging.
- Add a persisted project snapshot store under `.pixel-squad/project.json`.
- Add stub provider seams for Claude and Copilot-backed orchestration.
- Add GitHub Actions for CI and VSIX release packaging.
