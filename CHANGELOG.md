# Changelog

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
