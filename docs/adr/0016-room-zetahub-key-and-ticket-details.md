# 0016. A CLAUDE.md ZetaHub key is a suggestion; room tickets open a details dialog

- **Status**: Accepted
- **Date**: 2026-11-25
- **Scope**: `readRoomTickets` in `src/main/projectTickets.ts`, `ZetahubRow` and `ZetahubTable` in
  `src/shared/ticketSources.ts`, the room task columns and dialogs in `src/renderer/src/components/room/`

## Context
A project's ZetaHub key comes from the user (`StoredProject.zetahubKey`) or, failing that, from a
"ZetaHub project key:" line in the repo's `CLAUDE.md` (`zetahubKeySource` records which). The room reads the
local ZetaHub cache for either key. A repo the user does not control can therefore make its room show another
project's cached tickets as if they were its own (Rooms-e audit, 2026-11-23). An agent in that repo could read
the cache file anyway, so the harm is a misleading room, not a leak to the repo.

Separately, a room card shows a key, a title cut to three lines and little else. The person wants to open a card
and see the whole ticket. The cache holds `key, title, type, status, priority, assignee_id, milestone_id,
parent_task_id, updated_at`; it has no description.

## Options
### Key
- **A. Suggestion.** A `CLAUDE.md` key reads no tickets. The room shows the suggestion and a "Use this key"
  button that saves it as the user's key (existing `projects:setZetahubKey`). Cost: one click per project that
  relies on the file today.
- **B. Trusted projects only.** Use the file key when the project is trusted (ADR 0007). Couples ticket display
  to agent trust, and does nothing for untrusted rooms.
- **C. Label only.** Show "(from CLAUDE.md)" in the room. The repo still chooses what is shown.

### Details
- **A. Cache fields.** Everything the cache has, plus parent key and last update; local items show their full
  text, source and HIGH flag.
- **B. Cache fields plus description.** Needs the global `zetahub-cache.sh` to store descriptions, or a live
  ZetaHub read, which waits on the deferred in-app refresh (no `bypassPermissions` hidden run).
- **C. A now, B later.**

## Decision
**Key A, details C.**
- `readRoomTickets` returns `{ ok: false, key, reason: 'suggested' }` when `zetahubKeySource` is `claude-md`,
  before any cache file is read. The check is in main, on the project record main holds, so the renderer cannot
  skip it. The wall board count gets no number for it, like the other non-ok reasons.
- Accepting the suggestion stores the key as the user's. A later change to `CLAUDE.md` does not move it.
- `ZetahubRow` gains `parentKey: string | null` (the parent's key, looked up in the same tasks file, closed
  tickets included) and `updatedAt: string | null` (cleaned, at most 40 characters). `type` is already sent.
- A card is a button that opens a read-only details dialog built on the room's `Dialog` shell. Close is the first
  action; "Copy key" copies the displayed key. All values stay plain text with `dir="auto"` or `<bdi>`.
- The description is a local ticket for later (option B).

## Consequences
- Projects whose key came only from `CLAUDE.md` show the suggestion instead of tickets until accepted once.
- The project row still shows the file key with a dashed border, so the sidebar and the room agree on the source.
- The renderer payload grows by two short fields per row (at most 100 rows).
- Revisit when the in-app ZetaHub refresh lands: the dialog can then show the description.
