# 0007. Room trust identity, revocation and wiring module

- **Status**: Accepted
- **Date**: 2026-11-23
- **Scope**: main room wiring (`src/main/roomWiring.ts`), stored project state (`projects.json`), `~/.claude.json`

## Context
The Rooms-e review and security audit of ADR 0005 found four gaps in how a room lead's trust is stored and ended:
- Trust is bound to a path only (`StoredProject.trustedPath`). Deleting a repo and cloning another one into the
  same folder keeps it trusted, so the new repo's hooks and MCP servers start with trust pre-accepted.
- A trusted lead writes `hasTrustDialogAccepted` for its folder into `~/.claude.json`. Dropping our own trust
  leaves that flag, so Claude never asks again and an "untrusted" lead is not really untrusted.
- `room:openTerminal` stores trust before the spawn runs, so a failed spawn still skips the dialog next time.
- About 60 lines of room and trust plumbing sit inline in `src/main/index.ts` (about 5,500 lines), covered only
  by a source-regex test.

## Options
### Trust identity
- **A. Path + root commit.** Store the repo's root commit hash next to `trustedPath`; both must match.
  Pros: a re-clone of another repo is caught; stable across moves and restores. Cons: schema change; a repo
  without commits cannot be bound, so it asks every time. Testing: pure check in `src/shared/project.ts`, git
  read on a temp repo.
- **B. Path + `.git` file identity (inode / file id).** Also catches a re-clone of the same history. Cons: not
  stable across filesystems or backup restores.
- **C. Path only, documented.** No schema change; keeps the risk.

### Claude's own folder trust
- **A. Clear on revoke.** Keep pre-accepting; when trust is revoked or found stale, remove that folder's keys
  from `~/.claude.json`. Cons: the app writes the user's global Claude config.
- **B. Stop pre-accepting.** Claude asks once per folder in the lead terminal; one manual step per project.

### Trust stored before spawn
- **A. Roll back on failure.** Restore the previous `trustedPath`/`trustedRoot` when the spawn fails.
- **B. Save after spawn.** Conflicts with `spawnAgentCore` re-reading trust.
- **C. Keep and pin with a test.**

### Wiring location
- **A. New `src/main/roomWiring.ts`** with injected `homedir`, `lstat` and `readFile`, unit tested.
- **B. Fold into `roomIpc.ts`.** Mixes fs and config concerns into the IPC module.
- **C. Leave in `index.ts`.**

## Decision
- Trust identity: **A, path + root commit.** `StoredProject.trustedRoot` holds the sorted root commit hashes
  joined by `,`. A record without `trustedRoot` (saved before this ADR) is not trusted, so the person is asked
  once more. Git runs with `core.fsmonitor` and `core.hooksPath` turned off, because the repo is not yet trusted.
- Claude's folder trust: **A, clear on revoke.** Revoking, or finding the root commit changed, removes both
  spellings of the folder key from `~/.claude.json` and drops `trustedPath`/`trustedRoot`.
- Trust stored before spawn: **A, roll back on failure.**
- Wiring: **A, `src/main/roomWiring.ts`.**

## Consequences
- Every project trusted before this change asks once more.
- A repo with no commit yet never runs a trusted lead.
- A git failure (timeout, `safe.directory`) is not a different repo: the open asks again and keeps the stored
  trust; a lead spawned meanwhile runs untrusted.
- `~/.claude.json` is replaced with a temp file and a rename, and keys are matched with Windows letter case
  ignored. A claude that writes the file between our read and the rename still loses that one write.
- Accepted residual for the local ticket file on Windows: there is no `O_NOFOLLOW`, so a link swapped in
  between the open and the real-path check could be read through the handle. Comparing the handle's
  `dev`/`ino` with the walk is not reliable on Windows.
- A fork of the same project shares its root commit and stays trusted: the binding tells unrelated repos apart,
  not versions of one repo.
- Each trusted open and each lead spawn runs one `git rev-list --max-parents=0 HEAD`, bounded by a timeout.
- The "Forget trust" room action (in-progress list) calls the same revoke function.
- Not decided here: a per-spawn hook token, which would close both the late-hook gate release and hook-socket
  spoofing. It changes the hook payload, so it needs its own ADR.
