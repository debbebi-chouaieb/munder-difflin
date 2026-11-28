# 0019. Room leads start only from main; the renderer restarts one with `room:restartLead`

- **Status**: Accepted
- **Date**: 2026-11-28
- **Scope**: `pty:spawn` and `spawnAgent` in `src/main/index.ts`, `src/main/leadLock.ts`, `src/main/roomIpc.ts`,
  the preload bridge, Restore team (`useRestoreTeam.ts`), card restart (`CommandCenterPanel.tsx`) and
  auto-revive (`useHive.ts`)

## Context
A room open builds the lead's spawn in main (ADR 0005): command `claude`, the checked project folder, trust read
by main. Restore team, card restart, restart with a model and auto-revive after sleep reach the same lead through
`pty:spawn` with a command, args and cwd the renderer chose. Main re-decides trust there (ADR 0005, 0015) and the
lock keeps them off a forget (ADR 0017), but the renderer still picks what runs as the lead, and a spawned cwd
becomes a known fs/git root. ADR 0017 named option B, leads only through the room, as the direction.

## Options
- **A. New `room:restartLead(leadId)`.** Main finds the project from the lead id, stops a running lead, and runs
  the normal room open with the lead's last session. The four renderer paths branch on `isLeadAgentId`.
- **B. `resumeLast` on `room:openTerminal`.** No new channel, but the request format changes and each of the four
  renderer paths needs the project id of a lead.
- **C. No automatic restart.** `pty:spawn` refuses leads; the person reopens each room. No new API; leads stay
  stopped after a restore or a sleep.

## Decision
**A.**
- `pty:spawn` and main's `spawnAgent` refuse a lead id with a fixed message and start nothing. The install relaunch
  replays options main built (a room open), so it keeps the `spawn` hold of the lead lock (ADR 0017).
- `room:restartLead(leadId)`: an invalid id is `invalid-request`; no enabled project with that lead is
  `unknown-project`; a lead that is opening, spawning or being forgotten is `busy`. The restart is one room open
  under the lead's `open` hold; only once every open check passed does it stop the running lead (or clear a
  stopped card), then spawn. A refused restart leaves the running lead as it was. The open runs with
  `sessionId` = the lead's last recorded session when the project still lists it, else a new session, and
  `confirmLarge: true` (a restart continues work the person already ran). Trust, the cap, the lead lock and
  the fixed error codes are the open's own: an untrusted project answers `needs-trust`.
- The renderer: Restore team and auto-revive call it for a lead card; card restart calls it; restart with a model
  is refused for a lead (main picks the lead's agent, ADR 0015).

## Consequences
- The renderer can no longer choose the command, args or folder of a lead.
- Restore team lists an untrusted lead as a failure that names the room; the person opens it there.
- A lead's session older than the project's recent list restarts as a new session.
- The startup auto-restore restarts leads too, without a click, and does not ask again about a large session.
- Restore team restarts leads at once; past the room cap the extra ones fail with `room-cap` and the person opens
  them from their rooms.
- A refused auto-revive writes the reason on the lead's card.
- Non-lead spawns still take a renderer-chosen command and cwd; that part of the `pty:spawn` review stays open.
