# 0018. Claude folder trust still to drop is stored and retried

- **Status**: Accepted
- **Date**: 2026-11-27
- **Scope**: `StoredProject` and `Project` in `src/shared/project.ts`, `revokeTrust` in `src/main/roomWiring.ts`,
  the open and forget handlers in `src/main/roomIpc.ts`, `canForgetTrust` in the room panel model

## Context
Main revokes a room's trust on its own when the folder now holds another repo (ADR 0007) and when a trusted
spawn fails (the spawn may already have pre-accepted Claude's folder trust). `revokeTrust` drops the stored
trust first, so the project is untrusted even when `~/.claude.json` cannot be written. The folder trust the
app wrote for Claude then stays: the project reads untrusted, Forget trust has nothing to do and its button is
hidden, and the next untrusted lead runs in a folder Claude trusts, so Claude shows no prompt before the repo's
hooks and MCP servers start (Forget trust audit, 2026-11-26).

## Options
- **A. Store it on the project.** `claudeTrustToDrop` lists the folders whose Claude trust is still to go. It is
  written in the same save that drops stored trust and cleared once `~/.claude.json` is written. It survives a
  restart. Cost: one optional field in `projects.json`.
- **B. Remember it in memory in the room wiring.** No schema change; lost when the app quits right after the
  failure, which is when it matters.
- **C. Drop Claude's trust first and keep stored trust when that fails.** No new state, but after a failed spawn
  the next open runs trusted without asking again.

## Decision
**A.**
- `StoredProject.claudeTrustToDrop?: string[]`: one or two folders (the stored project path and the folder the
  lead resolved to), each at most 1024 characters. Malformed values are dropped on read. A record without it
  reads as `[]`. `Project.claudeTrustToDrop` carries the list.
- `revokeTrust` saves `trustedPath: null, trustedRoot: null, claudeTrustToDrop: <folders>` in one patch, then
  drops Claude's trust for those folders and clears the field when that worked.
- A room open and Forget trust retry a pending list first, under the lead lock (ADR 0017). The open **fails
  closed**: when the retry fails it returns the new code `trust-cleanup-failed` and starts nothing. Forget
  trust returns `forget-failed`.
- The Forget trust button also shows when the list is not empty, so the person has a way to retry.
- Claude's trust is only ever removed for folders the app recorded itself, as before.

## Consequences
- A room whose cleanup keeps failing (a locked `~/.claude.json`) cannot open until the file is writable.
  That is the intent: opening would run the repo's hooks without Claude's prompt.
- `projects.json` gains an optional field; older app versions ignore it.
- A stale repo opens only once Claude's part is dropped. A failed save of the stored part alone still asks
  (the stale trust is never used) and is dropped again on the next open. `revokeTrust` says which part failed.
- The open and Forget trust read the project again once they hold the lead lock, so a drop recorded by an open
  that ran meanwhile is not missed.
- If the record cannot be cleared after a successful drop, the next retry drops the same folders again. Trust
  given since then is removed with it and Claude asks once more: more asking, never less.
- A crash between a spawn's pre-accept and the revoke's save leaves no record. That window is accepted.
