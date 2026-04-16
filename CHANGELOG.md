# Changelog

## [0.1.30] — 2026-04-16
### Fixed
- **Copilot quota degradation**: When Copilot premium quota is exhausted, Pixel Squad now falls back more gracefully instead of surfacing the raw quota failure message as the main routing experience.
- **Chat-model reuse**: Persona-targeted `@pixel-squad` requests now reuse the model already selected in Copilot Chat for downstream assignment/execution startup, reducing needless model mismatches.
### Changed
- **Lower-cost Copilot preference**: Pixel Squad now prefers Auto/mini-like Copilot models when selecting a model itself, which reduces premium-request burn during normal routing and execution.
- **Deterministic fast-routing coverage**: Single-domain prompts now fast-route across more personas, and planning-only prompts fast-route directly to the lead persona more often, cutting unnecessary planning calls.
### Notes
- **Validation status**: `npm run build` passes for `0.1.30`. Extension-host E2E remains blocked in this environment by the VS Code bootstrap error `Code is currently being updated`.

## [0.1.29] — 2026-04-16
### Added
- **Persona-targeted `@pixel-squad` chat commands**: Copilot Chat can now route directly to `lead`, `frontend`, `backend`, `tester`, `devops`, or `designer`, automatically reusing or provisioning a matching room agent when needed.
- **Changed-file visibility in the UI**: Task cards and the inspector now surface changed file paths directly, so you can see what an agent touched without digging through the full diff preview.
### Fixed
- **Queued task takeover for new room agents**: Spawning an agent into a room with queued work now defaults to moving the oldest queued task onto that new agent, carrying forward captured workspace context and pinned file hints.
- **Planning-task timeout failures**: Prompts that are clearly asking for a plan, roadmap, or approach now use a planning-only response path instead of the heavy tool-execution loop, avoiding the 60-second execution timeout seen on plan-only requests.
### Changed
- **Chat-to-factory workflow**: Persona-targeted chat requests now update the live Pixel Squad panel in a GHCP-style flow where the selected persona is represented by a visible room agent and task.
### Notes
- **Validation status**: `npm run build` and VSIX packaging pass for `0.1.29`. Extension-host E2E remains blocked in this environment by the VS Code bootstrap error `Code is currently being updated`.

## [0.1.28] — 2026-04-16
### Added
- **Spawn-time queued-task takeover**: Creating an agent inside a room can now immediately reassign one queued room task to that new agent from the spawn dialog.
### Fixed
- **Agent/task status drift**: Agent grid state is now reconciled from live task state so planning, executing, waiting, and idle stay aligned across the board, inspector, and task wall.
- **Execution start latency**: Task creation and execution no longer block on full workspace-context hydration before starting; agents now begin from lightweight context and fill richer workspace context in the background.
### Changed
- **Active progress visibility**: Task cards and the inspector now show clearer five-step progress with animated active-state fills, making long-running work easier to track.
- **Tool loop bound**: Tool-calling execution now hard-stops after 12 rounds instead of 25, reducing pathological long-tail runs when an agent gets stuck exploring.
- **Tool prompt clarity**: Copilot and Claude execution prompts now explicitly tell agents to use surfaced MCP and extension-provided tools when available.
### Notes
- **Validation status**: `npm run build` and VSIX packaging pass for `0.1.28`. Extension-host E2E is still blocked in this environment by the VS Code bootstrap error `Code is currently being updated`.

## [0.1.27] — 2026-04-16
### Added
- **Persona-coded astronaut sprites**: The live factory board and room roster now render brighter astronaut-style role sprites so frontend, backend, QA, lead, devops, and design agents are visually distinct at a glance.
### Fixed
- **E2E host selection**: The test and record harnesses now reject installs with update-staging markers and prefer a cleaner local/fallback host selection path, reducing contamination from stale `.vscode-test` state.
- **Settings drift**: `pixelSquad.autoExecute` is opt-in again across the manifest, coordinator fallback, reset snapshot, and test flow, so fresh installs, resets, and command toggles now behave consistently.
- **Workspace-context default drift**: `workspaceContextMaxFiles` now resolves to `3` consistently in runtime fallbacks and reset state, matching the shipped configuration.
### Changed
- **Release docs sync**: README release notes, sidebar placement guidance, settings defaults, and tag example now reflect the current extension behavior instead of the older `v0.1.6` copy.
### Notes
- **Validation status**: `npm run build` and VSIX packaging pass for `0.1.27`. `npm run test:e2e` is still blocked in this environment by the VS Code host bootstrap error `Code is currently being updated`, so this release is build-validated rather than E2E-validated.

## [0.1.26] — 2026-04-15
### Added
- **MetroCity agent sprites**: Factory-floor agents and room roster cards now use repo-local MetroCity character art derived from the pack's CC0 public preview, replacing the older CSS-only placeholder characters.
### Changed
- **Agent click navigation**: Clicking an agent now reveals that agent's current focus task in the Task Wall, clears filters that would hide it, expands the task card, and scrolls it into view.
- **Factory stage presentation**: Room stages now use a more explicit top-down office-floor treatment so the board reads closer to the intended scene layout.
### Notes
- **E2E harness status**: Release build is verified, but the VS Code test host on 1.116.0 is currently failing to launch in this environment with `Code is currently being updated`, so release validation is build-backed rather than e2e-backed.

## [0.1.24] — 2026-04-15
### Fixed
- **Agent jitter**: Reduced motion step sizes by ~60% and increased animation durations across all status profiles (idle, executing, planning, etc.) — agents now drift smoothly instead of twitching.
### Added
- **Inspector quick-assign**: Assign textarea is now always visible at the top of the inspector panel (above the tab bar) — no longer buried at the bottom of the Assign tab. Supports Ctrl/Cmd+Enter to submit.
- **Agent dropdown in composer**: The global Route Task composer now has a "Quick-assign to" dropdown listing all agents. Selecting an agent bypasses the planner and assigns directly; leaving it on "auto-route" uses the Coordinator as before.
- **Auto-fix loop**: When a `runCommand` tool call returns a non-zero exit code, the agent automatically receives a follow-up instruction to read the error, apply a targeted fix with `editFile`, re-run the command, and verify with `getDiagnostics`.
### Changed
- **Inspector tabs**: Removed the redundant standalone `⚡ Assign` tab — task assignment is now inline at the top of every inspector view.

## [0.1.23] — 2025-06-18
### Added
- **editFile tool**: Targeted `oldString → newString` replacement for existing files — agents no longer need to rewrite entire files. Matches must be unique (exactly one occurrence).
- **getDiagnostics tool**: Agents can now check compile/lint errors after making changes, using `vscode.languages.getDiagnostics()`. Returns errors and warnings with file, line, severity, and message.
- **Line-range readFile**: `readFile` now accepts optional `startLine`/`endLine` parameters for reading specific sections of large files with numbered output.
- **Self-correction system message**: Tool-calling loop now injects a system-level instruction guiding agents to read before editing, prefer editFile, check diagnostics after changes, and fix errors before finishing.
### Changed
- **Command timeout**: Increased from 15s to 60s to support longer-running operations (npm install, builds, test suites).
- **Tool round limit**: Increased from 15 to 25 rounds, allowing agents more iterations for complex tasks with error recovery.
- **Adapter prompts**: Both CopilotAdapter and ClaudeAdapter now mention all 8 tools (readFile, editFile, writeFile, listFiles, searchText, getDiagnostics, runCommand, sendAgentMessage) and instruct agents to use editFile for existing files and getDiagnostics for verification.
- **toolsExecuted flag**: Now also set when `editFile` is used (previously only writeFile and runCommand).
- **Plan builder**: `buildPlanFromToolCalls` now tracks `editFile` calls as file edits with action `'replace'` and records `getDiagnostics` calls in notes.

## [0.1.22] — 2025-06-18
### Added
- **Real tool-calling agents**: Agents now use the VS Code Language Model tool-calling API instead of the JSON-parse pattern. During task execution, agents can call `readFile`, `writeFile`, `listFiles`, `searchText`, `runCommand`, and `sendAgentMessage` tools to interact with the workspace in real time.
- **Agentic execution loop**: New `runToolCallLoop` drives a multi-round conversation where the LLM reads code, makes changes, runs commands, and verifies results — up to 15 tool-calling rounds per task turn.
- **MCP tool discovery**: Automatically discovers tools registered by MCP servers or other VS Code extensions via `vscode.lm.tools` and makes them available to agents during execution.
- **Automatic JSON-parse fallback**: If a model does not support tool-calling, the adapter transparently falls back to the legacy JSON plan mode — no user intervention needed.
- **Tool call streaming**: Each tool invocation streams a progress indicator (`🔧 toolName(...)`) and result preview to the webview, so users see agent actions in real time.
- **Security guardrails**: Path traversal protection on all file tools, dangerous command blocking (`rm -rf /`, `format`, `shutdown`, etc.), and bounded output sizes.
### Changed
- **Coordinator**: Recognizes `toolsExecuted` flag on execution results — skips re-applying file edits and terminal commands that tools already executed during the LLM loop.
- **Adapter prompts**: Tool-calling mode uses natural-language prompts (no JSON schema instructions). File contents are provided as hints; agents use `readFile` to inspect files themselves.

## [0.1.21] — 2025-06-17
### Changed
- **Debounced persistence**: `store.save()` calls coalesced via a 500 ms debounce timer — disk writes dropped from ~20 to 2-3 per task.
- **Async writes**: New `saveAsync()` method on `ProjectStateStore` uses `fs.promises.writeFile` to avoid blocking the extension host.
- **Stale task reaper fix**: Reaper now checks `scheduler.isRunning()` before failing a task; threshold raised to 5 minutes; `updatedAt` refreshed between multi-turn iterations.
- **Dispose chain**: `Coordinator.dispose()` flushes pending saves and clears the debounce timer.

## [0.1.19] — 2026-04-14
### Added
- **Fleet mode**: New `🚀 Fleet` button in the hero composer and `Pixel Squad: Fleet Execute` command — sends the same prompt to ALL idle agents simultaneously for maximum parallelism.
- **Futuristic pixel animations**: Neon glow rings under each agent with status-specific colors (gold=executing, blue=planning, teal=idle, red=failed, green=completed), sparkle particles during execution, celebration emoji on completion, holographic flicker when paused, glitch-shake for blocked/failed.
- **Execution timeout**: Each LLM turn is wrapped in a 90-second `Promise.race` — if the model hangs, the turn is aborted and the task continues or fails gracefully.
- **Stale task reaper**: Background 60-second sweep auto-fails any task stuck in `active` state for more than 5 minutes, freeing scheduler slots and promoting downstream work.
### Changed
- **UI layout restructure**: "⚡ Assign Task" input moved from the bottom of the inspector (below Pinned Files, invisible to most users) to directly below the Inspector Spotlight — prime visible real estate.
- **FactoryBoard**: `data-status` attribute added to pixel-agent-shell elements, enabling CSS status-specific glow effects.
- **Extension lifecycle**: `dispose()` wired into `context.subscriptions` to clean up the stale-reaper timer on deactivation.

## [0.1.17] — 2026-04-14
### Fixed
- **Parallel execution root cause**: `enrichAssignments` was injecting a sequential `dependsOnPersonaIds` fallback (`index > 0 ? [prev] : []`) even when the LLM returned no dependencies. Tasks now run in parallel by default unless the planner explicitly declares ordering.
- **Progress label**: Removed hard-coded "Waiting on prior task" for index-1 assignments — all undeclared-dep tasks now show "Ready to start".
### Added
- **Fast-path routing**: Prompts that clearly match a single persona with ≥2 keyword hits (`tester`, `devops`, `designer`) skip the LLM planning call entirely — zero-latency routing.
- **Slim planning prompt**: Removed file contents and git status from the planning prompt (kept only branch + active file). Routing decisions don't need full file context — shorter prompt = faster LLM response.
- **VS Code status bar flash**: `$(check) <AgentName> finished "<task>"` appears for 5 seconds after every task completes.
- **Batch completion notification**: When all tasks from the same planning call reach `done`/`review`/`failed`, a single VS Code info toast fires with a count summary and an "Open Panel" button.
- **Webview done flash**: Completed task cards pulse with a green glow animation (`done-flash` keyframe) so the user sees completion immediately in the panel.
- **`batchId` on `TaskCard`**: Tasks from the same `createTask()` call share a `batchId` enabling the batch-complete notification.

## 0.1.16

- **Fix: `Cannot access 'dependencyIds' before initialization`** — `dependencyIds` was declared after it was referenced (temporal dead zone bug introduced in v0.1.14). Moved the declaration above the `refreshedAgent` block so the variable is always initialized before use. `@pixelSquad` routing no longer crashes immediately on every task.

## 0.1.15

- **Fix: prose response no longer crashes task execution** — when Claude or Copilot returns plain English instead of a JSON execution plan (e.g. `"I need to ..."` due to context limits or a refusal), the adapter now catches the parse error gracefully and surfaces the model's text in the task notes instead of failing with `Unexpected token 'I' is not valid JSON`. Tasks complete with `done: true` so the factory never gets stuck.

## 0.1.14

- **Parallel agent execution**: Tasks no longer chain sequentially by default. Previously every task after the first was given an implicit dependency on its predecessor, causing agents to queue even when their work was fully independent. Now only planner-declared `dependsOnPersonaIds` create real dependencies — independent subtasks run concurrently across all 6 scheduler slots.
- **Open in Editor Panel**: New command `Pixel Squad: Open in Editor Panel` opens the factory UI as a full-width editor panel (`ViewColumn.Beside`) alongside your code or GitHub Copilot Chat, giving far more room than the 300 px sidebar. Trigger it from the Command Palette.
- **Chain of Dependencies view**: Expanded task cards now show a "Chain of Dependencies" section when the task has upstream dependencies. Each upstream task is rendered as a node (status badge + title + assigned agent) connected by `→` arrows to the current task, so you can see at a glance what a queued task is blocked on.

## 0.1.13

- **Fix URI routing crash** (root cause resolved): `WorkspaceContextService.capture()` is now wrapped in a top-level `try/catch` that falls back to the lightweight snapshot — a malformed tab `input` object or any unexpected runtime error can no longer propagate as "Pixel Squad routing failed". Also fixed `'input' in tab` guard to additionally check `tab.input != null` before accessing `.uri`.
- **Fix dialog overflow/scroll**: `.dialog` CSS now sets `max-height: calc(100vh - 48px)` and `overflow-y: auto` so the Spawn Agent and Create Room dialogs are always scrollable when the custom persona form is expanded.
- **Faster task routing**: `MAX_FILES` reduced from 10 to 4; workspace symbol search capped at 4 tokens with a 2 s `Promise.race` timeout; import-chain expansion limited to 2 extra files; `workspaceContextMaxFiles` config default lowered from 6 to 3. Task routing should feel noticeably snapper on large workspaces.
- **UX-01 — First Run Banner**: new dismissible on-boarding banner appears inside the factory panel whenever no rooms or agents have been created yet; walks through the three-step setup (Room → Agent → Task).
- **UX-02 — CSS state transitions**: `.task-card` now transitions `background`, `border-color`, and `box-shadow` over 0.2 s; `.status-badge` transitions `background`, `color`, and `border-color` over 0.25 s so status changes animate smoothly instead of jumping.
- **UX-03 — VS Code CSS tokens**: `.dialog` background now uses `var(--vscode-editorWidget-background)`; `.dialog-input / .dialog-textarea` use `var(--vscode-input-background)` and `var(--vscode-input-border)`; `.dialog-label` uses `var(--vscode-input-placeholderForeground)`. All fall back to the existing dark-theme values.
- **UX-05 — Toast notifications**: background task/provider events are now surfaced as slide-in toast notifications at the bottom-right of the panel (task completions → green, failures/provider-unavailable → red, other → info). Toasts auto-dismiss after 3.5 s.

## 0.1.12

- **Secondary sidebar (manifest fix)**: `viewsContainers` key changed from `activitybar` to `secondarySideBar` in the extension manifest so VS Code places Pixel Squad in the right-hand secondary sidebar from first install — no programmatic workaround needed. Removed the unreliable one-shot `moveViewContainerToAuxiliaryBar` runtime call.
- **Happy multi-agent icon**: new `icon-activitybar.svg` showing three pixel-robot agents (left/center/right) with U-shaped smiles, antennae, and sparkle squares.
- **Tasks auto-complete without stuck review**: when `autoExecute=true`, a failed file-apply step (e.g. no workspace root) no longer drops the task into `review` state — it completes to `done` so agents never get stuck waiting for approval.
- **Reduced agent task-splitting**: planner prompt now defaults to exactly 1 assignment for simple tasks; 2–3 only when work genuinely spans multiple independent components. Eliminates unnecessary multi-agent churn on trivial requests.
- **Removed confusing Execute button**: active tasks no longer show a redundant `▶ Execute` button — they are already executing.

## 0.1.11

- Fix **routing crash** (`Cannot read properties of undefined (reading 'uri')`): add optional chaining in `WorkspaceContextService.searchWorkspaceSymbols` so a symbol provider returning an incomplete `SymbolInformation` object no longer throws.
- **Secondary sidebar by default**: on first activation the extension calls `workbench.action.moveViewContainerToAuxiliaryBar` to move Pixel Squad's panel to the right-side secondary sidebar automatically. VS Code remembers the position permanently so this fires only once.
- **Auto-execute on by default**: `pixelSquad.autoExecute` now defaults to `true`. Tasks execute and file changes are written immediately after planning — matching GitHub Copilot agent mode behaviour. Toggle the button in the factory header to switch back to review mode.
- **Activity bar icon**: new monochrome 24×24 SVG (`icon-activitybar.svg`) that renders clearly in VS Code's activity bar.
- **Providers tab**: fifth sidebar tab showing live LM provider status (Copilot / Claude) and agent distribution metrics.
- **Tab labels** updated to match prototype: Factory → Agent Factory, Feed → Activity Feed.

## 0.1.10

- Fix **activity bar placement**: ensure `viewsContainers` key is `activitybar` (not `panel`), and add `workbench.action.moveView` call in `showFactory` to reset VS Code's cached panel position back to the sidebar.
- Fix **task routing reliability**: wrap `createTask`, `assignTask`, and `taskAction` message handlers in try/catch so the webview always receives a snapshot update. Previously, a failed Copilot/Claude LM call left the "Route Task" button stuck on "Routing..." forever and tasks never reached agents.
- Show **error notifications** when routing or assignment fails instead of silently swallowing the error.

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
