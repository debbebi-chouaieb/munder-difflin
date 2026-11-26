# 0012. "Forget trust" from the room panel

- **Status**: Accepted
- **Date**: 2026-11-26
- **Scope**: main `room:*` IPC (`src/main/roomIpc.ts`), preload bridge, renderer `RoomPanel`

## Context
ADR 0007 made `roomWiring.revokeTrust` drop a project's stored trust (`trustedPath`, `trustedRoot`) and Claude's
folder trust in `~/.claude.json`, and named a "Forget trust" room action as its user-facing caller. Only main used
it (stale repo, failed spawn); the person had no way to take back a "yes". Three choices came up: the bridge
call's shape, what to do while the lead runs with trust, and whether to confirm first.

## Options
### Bridge call
- **A. `room:forgetTrust(projectId)`.** Same shape as the other `room:*` calls (ADR 0005): an id only, main
  resolves the folder. Answers `RoomDone`. Testing: handler unit tests with injected deps.
- **B. `projects:setTrusted(id, bool)`.** A general setter. Trust must only be granted through the open flow's
  dialog, so a setter that also takes `true` invites misuse.

### Lead running
- **A. Only when no lead runs.** The panel hides the button; main refuses with `busy`.
- **B. Stop the lead, then forget.** One click kills a live session without a separate Stop.
- **C. Forget, the lead keeps running.** Its hooks and MCP servers are already loaded, and the hook gate
  (`trustedLeadFolder`) reads trust on every hook, so the session changes under the person.

### Confirm
- **A. No dialog.** A "yes" at the next open undoes it; a notice line says it was done.
- **B. A confirm dialog.**

## Decision
- Bridge: **A, `room:forgetTrust(projectId)`.**
- Lead running: **A.** Main also refuses while an open of the same room is in flight, and an open that arrives
  while trust is being dropped answers `busy`, so no open reads trust half gone.
- Confirm: **A, no dialog.**
- A project that is not trusted answers done without touching `~/.claude.json`: Claude's trust for that folder
  may be the person's own.

- Order: "Forget trust" drops Claude's folder trust first and the stored trust only once that worked
  (`roomWiring.forgetTrust`). Main's own `revokeTrust` (stale repo, failed spawn) keeps the reverse order, because
  there stored trust must go even when `~/.claude.json` cannot be written. With the reverse order here, a locked
  `~/.claude.json` would clear `project.trusted`, hide the button, and leave Claude trusting the folder with no
  way to retry. This amends ADR 0007's note that the room action calls the same revoke function.

## Consequences
- New error code `forget-failed` (a part was not saved, or the revoke threw); the detail stays in the main log.
- The button disappears when main pushes the project snapshot without trust; the panel keeps no trust state.
- A disabled project can still forget its trust from main, like Stop; the panel only shows it for enabled ones.
