# Changelog

## 0.1.9

- Move the Pixel Squad view container from the **bottom panel to the Activity Bar** so the factory board is always one click away as a first-class sidebar.
- Add **`toggleAutoExecute` menu button** in the panel title bar so users can flip auto-execute on/off without opening settings — also wired as a `ToggleAutoExecuteMessage` from the webview.
- Fix `autoExecute` default to **`false`** (opt-in) to prevent tasks from being auto-executed on first launch; `getSnapshot()` now injects live VS Code config at read time so settings are always fresh.
- Remove the **XP / level system** from agents — `xp`, `level`, `xpForLevel`, and `levelFromXp` are gone; the faculty inspector and room stage no longer show `Lv.N` labels or award XP on task completion.
- Rewrite the **CSS design system** using VS Code theme tokens (`--ps-bg`, `--ps-panel`, `--ps-accent`, `--ps-text`, etc.) and switch from Georgia/serif to the `Segoe UI` system-ui sans-serif stack for native IDE feel.
- Add **`focus-visible` keyboard-navigation ring** across all interactive elements (buttons, inputs, textareas, selects).
- Add **room state badges** (`Live` / `Ready`) and a **metrics row** (`N agents · N busy · N queued`) to each room card on the factory board.
- Rooms with active work receive a `factory-room--live` highlight; the room containing the currently selected agent receives `factory-room--selected`.
- Upgrade the Activity Feed to render **structured `ActivityEntry` objects** with category icon badges (system / task / agent / provider) and relative timestamps instead of raw strings.
- Add `refresh()` public method on `PixelSquadViewProvider` so the `toggleAutoExecute` command can push updated state to the webview without a full re-render.

## 0.1.8

- Add **per-agent pinned context files** so each agent can carry its own curated workspace context between tasks.
- Add **quick pinning of the active editor file** from the agent inspector, alongside the searchable workspace file picker.
- Improve task execution UX: when auto-execute is enabled, generated file edits can be applied automatically instead of forcing repeated manual execute/review clicks.
- Reduce UI clutter by stopping completed task output from auto-expanding in the webview inspector.
- Upgrade workspace context capture to use the model's **real token budget** (`countTokens()` and `maxInputTokens`) instead of fixed snippet limits.
- Improve file retrieval with **workspace symbol search** and **import graph expansion**, so agents pull in more relevant code and related dependencies.

## 0.1.7

- Add **agent mailbox system**: each agent gets an in-memory inbox; the Coordinator runs a multi-turn execution loop (up to 3 turns) where agents check for incoming messages between LM calls and can send messages to other agents in their room.
- Add **`AgentMessage` model type** with `AgentMessageType` (`request` | `inform` | `query` | `response`) for structured inter-agent communication.
- Add **`AgentMailbox` class** (`send`, `drain`, `peek`, `broadcastToRoom`, `clear`) for routing messages between agents.
- Add **`AgentChatMessage` protocol message** so the webview receives real-time agent-to-agent chatter.
- Add **`agentChatBus`** on the Coordinator and wire it through to the webview via `PixelSquadViewProvider`.
- Add **`agent-chat` activity category** so inter-agent messages appear in the Activity Feed with a dedicated filter.
- Extend **`ExecutionResult`** with `outgoingMessages` and `done` fields for multi-turn support.
- Update **Copilot and Claude adapters** to accept `inboxMessages`, inject them into prompts, and parse `agentMessages`/`done` from LM JSON responses.
- On task completion, **broadcast a summary** to all room peers via the mailbox so co-located agents gain context.

## 0.1.6

- Add **task handoff system**: completed predecessor tasks automatically generate `HandoffPacket` objects that carry summary, files changed, commands run, tests, and open issues to downstream tasks, giving continuity across the agent chain.
- Add **parallel task execution**: a `TaskScheduler` enforces a configurable concurrency cap (default 3) with double-start prevention, allowing multiple agents to execute simultaneously.
- Add **auto-promotion**: when a task completes, `promoteReadyTasks()` scans queued tasks and auto-executes any whose dependencies are now fully met (respects scheduler capacity).
- Add **room-aware context**: the agent's room (name, theme, purpose) is now passed to Copilot and Claude execution prompts so agents understand their operational domain.
- Add **captured command execution results**: running review commands now stores stdout, stderr, exit code, and duration directly on the task instead of only dispatching commands to a terminal.
- Add **diff-first review cards**: proposed file edits now carry workspace snapshots and render with a patch-style preview before approval.
- Add **"By room" grouping** to the Task Wall in the webview, alongside existing "By status" and "By agent" modes.
- Display **handoff packets** in expanded task cards so users can see what predecessor agents passed forward.
- Update Copilot and Claude adapter `executeTask` signatures to accept `Room` and `HandoffPacket[]` parameters.

## 0.1.5

- Add structured activity entries, task progress metadata, dependency metadata, and persona skill hints across the shared model, coordinator, persistence layer, and webview protocol.
- Rework the Task Wall into a grouped and filterable board with progress bars, assignee context, dependency badges, and categorized activity feed rendering.
- Enrich Copilot and Claude planning so routed tasks carry dependency, skill, and progress hints, with deterministic fallback planning normalized through shared helper logic.
- Add a recordable real VS Code host demo flow via `npm run demo:e2e:record` and document the release/demo workflow in the README.

## 0.1.4

- Rework the factory board into an animated room stage so agents move within each room instead of stacking as static tiles.
- Shrink mood and provider emoji into compact badges to prevent overlap with agent labels and task bubbles.
- Add status-aware wandering motion with directional facing to make the floor feel closer to pixel-agents.
- Add automated extension-host E2E smoke coverage and reset-store support for deterministic workspace restoration.

## 0.1.3

- Add **mood system**: agents display status-based emojis (😴 idle, 🤔 planning, 💪 executing, ☕ waiting, 😰 blocked, ⏸️ paused, 🎉 completed, 😵 failed).
- Add **thought bubbles**: agents that are executing or planning show a floating bubble with their current task title.
- Add **XP / Level system**: agents earn 25 XP per completed task, level up automatically, with progress bars on agent tiles and inspector.
- Add **Agent Work panel**: clicking an agent shows all their assigned tasks inline in the inspector sidebar with expandable output.
- Add **CLI commands**: `Pixel Squad: Assign Task to Agent` (QuickPick + InputBox) and `Pixel Squad: List Agents` for Command Palette workflows.
- Add **confetti celebration**: completed agents show 🎉✨ particles rising from their character.
- Inspector now shows mood, XP bar, and full agent task timeline.
- 9 files changed, 365 insertions.

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
