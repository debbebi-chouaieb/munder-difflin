# 0017. One lock per room lead for opens, pty spawns and Forget trust

- **Status**: Accepted
- **Date**: 2026-11-27
- **Scope**: `src/main/leadLock.ts`, `createRoomWiring` in `src/main/roomWiring.ts`, the open and forget
  handlers in `src/main/roomIpc.ts`, the `pty:spawn` handler in `src/main/index.ts`

## Context
"Forget trust" (ADR 0012) refuses while the room's own open runs, and the open refuses while a forget runs.
Both checks live in `roomIpc.ts` (`opening`, `forgetting`). Restore team and a card restart start a lead
through `pty:spawn` instead, straight into `spawnAgentCore`, and see neither set. That spawn can read the
project as trusted before the forget drops it, then pre-accept Claude's folder trust while the forget rewrites
`~/.claude.json`, leaving Claude trusting a folder the person just forgot (Forget trust audit, 2026-11-26).

## Options
- **A. One lock owned by main's room wiring.** A small lock keyed by lead agent id, held as `open`, `spawn` or
  `forget`. The room open and forget take it; `pty:spawn` takes it for a lead id. One place knows who holds a
  room. Cost: the wiring holds one more piece of state.
- **B. Leads only through `room:openTerminal`.** `pty:spawn` refuses lead ids; Restore team and card restart
  call the room open. Also removes the renderer-chosen command and cwd for leads, but changes the restore flow
  (trust prompt on restore) and is a larger change.
- **C. Cross-checks.** `spawnAgentCore` asks `isForgetting`, forget asks a new `leadSpawning` set. Smallest diff;
  the rule is split over two files and every new path must remember both checks.

## Decision
**A.**
- `createLeadLock()` keeps at most one holder per lead id. `run(leadId, holder, work)` returns null when the id
  is held, else runs `work` and frees the id when it settles, also when it throws.
- The key is the lead agent id (`leadAgentIdFor`). `pty:spawn` already has it, and a spawn whose id matches no
  project runs untrusted (no pre-accept), so it cannot race a forget.
- The room open still shares a double click's result through `opening`; the lock replaces `forgetting` and
  also refuses an open while a `pty:spawn` of the same lead runs.
- `pty:spawn` for a held lead returns `{ ok: false }` with a fixed message and starts nothing. Spawns that are
  not leads take no lock. The room's own open calls `spawnAgentCore` under its `open` hold and takes no second one.

## Consequences
- A Restore team that lands during a forget fails that lead with a "busy" error; the person restarts it.
- A room open during a restored lead's spawn is busy instead of starting a second process.
- A `pty:spawn` of a lead during a room open, or during another spawn of the same lead, is refused with the
  same error. Restore team keeps that agent restorable and lists the reason; a card restart shows it.
- The install relaunch re-arms the terminal only once it holds the lock, so a refused relaunch leaves the
  install output on screen.
- `room:closeTerminal` still waits only for a room open, not for a pty spawn of the lead (unchanged here).
- Option B stays the direction for the wider `pty:spawn` trust review (renderer-chosen command and cwd).
