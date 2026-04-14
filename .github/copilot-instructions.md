# Pixel Squad — Project Guidelines

## Vision

Pixel Squad is a VS Code extension that makes multi-agent development **fun, fast, and accessible** to developers who don't want a CLI. Every code change, feature, and fix must pass this test:

> *Does this make multi-agent workflows more enjoyable, faster, or more visually compelling for a developer who prefers a GUI over a terminal?*

If the answer is no, rethink the approach. The target user is a developer who wants the power of multi-agent orchestration without ever opening a shell.

---

## Architecture Snapshot

| Layer | Files | Purpose |
|-------|-------|---------|
| Orchestration | `src/extension/coordinator/Coordinator.ts` | Task creation, dependency enforcement, agent state machine, scheduler (cap 6) |
| Providers | `src/extension/providers/copilot/CopilotAdapter.ts`<br>`src/extension/providers/claude/ClaudeAdapter.ts` | LLM integration — both implement `ProviderAdapter`; **must stay in sync** |
| Planning | `src/extension/providers/planningHints.ts` | Skill inference, persona descriptions, deterministic keyword fallback |
| View host | `src/extension/PixelSquadViewProvider.ts` | Sidebar + editor panel; shared logic via `handleWebviewMessage()` |
| Webview UI | `webview-ui/src/App.tsx`, `webview-ui/src/styles.css` | React/Vite UI — `App.tsx` is the root, `styles.css` is the only stylesheet |
| Protocol | `src/shared/protocol/messages.ts` | Message types shared between host and webview |

---

## Critical Rules

### 1. Keep both adapters in sync
`CopilotAdapter.ts` and `ClaudeAdapter.ts` share the same `ProviderAdapter` contract. Any change to `parseExecutionPlan`, `createPlan`, or `executeTask` in one **must** be mirrored in the other. They diverging silently is a regression.

### 2. No temporal dead zones in Coordinator
In `Coordinator.ts` `createTask()`, always declare `dependencyIds` **before** `refreshedAgent`. `refreshedAgent` references `dependencyIds` in its value. Declaration order matters — this caused a crash in v0.1.15 and was fixed in v0.1.16. Do not reorder.

### 3. Graceful fallbacks for model output
`parseExecutionPlan` in both adapters wraps `JSON.parse` in try/catch. LLMs return prose instead of JSON — this is expected. Never remove or bypass the fallback.

### 4. All webview messages route through `handleWebviewMessage()`
Both the sidebar and editor panel share `handleWebviewMessage(message, syncSnapshot, postMessage)`. Do not add message-handling logic inline to `resolveWebviewView` or the panel's `onDidReceiveMessage`.

### 5. No inline styles in TSX
All styles live in `webview-ui/src/styles.css`. Never use `style={{}}` attributes in TSX components.

### 6. Tasks run in parallel unless explicitly dependent
Do not infer sequential chaining between tasks. Only use `dependsOnPersonaIds` supplied by the planner. The `autoExecute` loop fires **all** active tasks, not just the first.

---

## Build & Commit

```bash
# Always build and verify clean before committing
npm run build

# Release commit pattern
git add -A
git commit -m "Release vX.X.X - <short description>"
git tag vX.X.X
git push origin main --tags
```

The `dist/` artifacts are committed. Never push without a successful build — TypeScript errors are caught at build time, not at runtime.

---

## UX Principles

- **Reduce friction**: If a user has to open a terminal to do something, that's a gap to close.
- **Visual feedback is required**: Every async operation (task running, agent thinking, handoff) must have a visible state change in the UI.
- **Agents have personality**: Naming, sprites, XP, levels — lean into the factory/team metaphor. Don't strip it for "cleanliness".
- **Dependency chains are visible**: When a task depends on another, the user must be able to see that relationship without reading logs.
