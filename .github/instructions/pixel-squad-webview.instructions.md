---
description: "Use when editing the Pixel Squad webview UI — App.tsx, React components, styles.css, expanding task cards, adding new visual sections, or changing the agent factory layout."
applyTo: "webview-ui/src/**"
---

# Pixel Squad Webview Guidelines

## North Star
Every UI element should make multi-agent orchestration feel **engaging**, not mechanical. Think: animated factory floor with personality — not a flat task table. When in doubt, ask: *would a developer who hates terminals find this delightful?*

## Style Rules
- All CSS goes in `webview-ui/src/styles.css`. Never use `style={{}}` inline attributes in TSX.
- Use existing CSS custom properties from the `:root` block (colors, spacing, radius tokens).
- New block names follow BEM-like naming: `.block__element--modifier` (e.g., `.dep-chain__badge--queued`).
- Status-aware classes use the pattern `--<status>` where status is one of: `queued | active | executing | done | failed | cancelled`.

## State Rules
- Read all agent/task/room data from the `snapshot` prop only. Never store server state in local `useState`.
- User actions must `postMessage({ type: '...' })` to the extension host. Do not compute business logic in the webview.
- Optimistic UI is acceptable for immediate feedback, but the snapshot from the host is always authoritative.

## Expanded Task Card Pattern
Sections inside an expanded task card (`expandedTaskId === task.id`) follow this structure:
1. Eyebrow label: `<p className="eyebrow">Section Name</p>`
2. Content block with a semantically named class

Existing sections in order: execution plan → file edits → terminal commands → handoff packets → **chain of dependencies**.
New sections should be appended after "chain of dependencies" unless there is a strong reason to reorder.

## Chain of Dependencies
The dep chain section renders only when `task.dependsOn?.length > 0`. It shows predecessor tasks with status badges and an arrow leading to the current task. Maintain this guard — do not render an empty dep chain section.

## Accessibility
- Arrow/divider characters used as decoration must have `aria-hidden="true"`.
- Status badges must convey status through text content, not color alone.
- Interactive elements (buttons, clicks on agent cards) must have accessible labels.
