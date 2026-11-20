# 0005. Project room panel: sessions, lazy lead terminal, ticket tables

- **Status**: Accepted
- **Date**: 2026-11-20
- **Scope**: project-wide (main `room:*` IPC, renderer `RoomPanel`, floor rooms)

## Context
Project rooms (ADR 0002) are drawn by pixi and have no click target or panel. Each room should show its project's
Claude Code sessions, a terminal, and two task tables: ZetaHub tickets and local "No ticket yet" items. Limits:
- Tokens: a Claude process loads its startup context (CLAUDE.md, tool and MCP schemas) as soon as it starts, and a
  resumed session re-sends its whole history on the first prompt.
- PC: each `claude` process costs memory. Terminals keep 100 000 lines of scrollback. PTY output is sent to the
  renderer one chunk at a time.
- Security: `pty:spawn` trusts a command and cwd chosen by the renderer, and a spawned cwd becomes a known root
  (`docs/in-progress.md`).
- The app has no ZetaHub client. The `zetahub-sync` skill keeps a local cache in `~/.claude/cache/zetahub`.

## Options
### A. Right-side RoomPanel fed by `room:*` IPC that takes a project id only
Clicking a room swaps the agent panel for `RoomPanel`. Main resolves every path and command from the project id.
Pros: reuses the splitter, the terminal pool and `PtyTerminalView`; the renderer never names a path or command.
Cons: four new IPC calls and a preload surface to keep.
Testing: pure parsers under `src/shared/`, service tests on temp folders, a source scan for the handlers.

### B. Reuse `pty:spawn` and `fs:*` from the renderer
Pros: no new IPC. Cons: widens the trust problem above; ticket and session parsing would run in the renderer on
files outside the workspace.

### C. Live ZetaHub client in the app
Pros: always fresh. Cons: a stored secret, a new auth flow, a security review; the cache already exists.

## Decision
We chose **A**, reading ZetaHub from the cache.

- IPC, all taking `projectId` (enabled projects; close also works for a disabled one) and resolving the path in
  main through `ProjectService`. Errors are fixed `RoomErrorCode` values; details go to the main log only.
  - `room:sessions` lists the 10 most recent `<uuid>.jsonl` in `projectDir(project.path)`. Main reads a 64 KB
    head (first prompt) and a 256 KB tail (title, context size) of each new or changed file, cached on mtime
    and size; calls within 2 s share one read. Only UUID session ids are listed or resumed.
  - `room:tickets` returns the ZetaHub rows from `tasks/<P>.jsonl` (open only, keys shown as `MDM-51`), the cache
    time from `meta.json`, and the bullets under `## No ticket yet` in the file named by `Local open work:`. That
    line is parsed during the project scan (`Project.localWorkPath`). The path is checked as text first; every
    segment must be a real folder or file (no links, so no network path is ever touched). All text is cleaned
    (control and bidi override characters removed) and capped.
  - `room:openTerminal` starts the project lead (ADR 0003, amended) with `--resume <id>` or a new session. Main
    builds the command and re-checks that the project folder is still a plain folder inside the workspace. A
    second click while it opens shares the first result; a running lead is re-announced, not spawned again.
  - `room:closeTerminal` waits for an open in progress, then kills the lead's PTY through the normal teardown.
- The lead's registry record is created on the first `room:openTerminal`, not when the project is ticked.
- `room:openTerminal` calls the existing `spawnAgentCore` with options built in main, so provider detection,
  hooks, resume seeding and teardown stay in one path.
- Session sizes come from the last assistant usage in the tail. Resuming above 100 000 context tokens asks first
  and offers a new session. With no usage in the tail, a transcript over 1 MB also asks (fail closed).
- Trust (security audit, 2026-11-20): `spawnAgentCore` pre-accepts Claude's folder-trust prompt and adds the
  auto-mode bypass flag, so one click could run a cloned repo's hooks and MCP servers. Room leads therefore need
  per-project trust, stored as `trustedPath` in `projects.json` (bound to the folder path, so a project id that
  moves to another folder does not carry trust).
  - The first open of an untrusted project returns `needs-trust`; the panel shows a dialog. "Trust" stores the
    path (only once every other check passed) and spawns as other agents do. "Open without trust" spawns once
    with `untrusted`: no pre-accept and no auto-mode flag, so Claude asks in the terminal.
  - Main decides trust for every lead spawn (`leadMustRunUntrusted` in `spawnAgentCore`), so Restore team and a
    card restart cannot bring back bypass for an untrusted lead: replayed bypass args are stripped, not only left
    un-added. Leads have ids `lead--<projectId>`, which Add Agent can never produce. Only lead spawns wait for
    the project list, at most 2 s; a lead whose project is unknown or late runs untrusted. Other agents are
    unchanged: picking their folder in Add Agent is the consent.
  - A "yes" that cannot be saved opens untrusted, because main re-reads trust at spawn.
  - Until a hook event proves a turn ran (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`), no
    automation types into an untrusted lead: the wake watchdog skips it and the renderer drain holds even "send
    now" (`trustPending`), because Enter at that prompt answers "yes". `Status` and `SessionStart` do not count:
    whether they fire before the prompt is answered is unverified. The gate also opens when the terminal closes.
  - `needs-trust` carries `claudeTrusts`: when Claude already trusts the folder or a parent (`~/.claude.json`),
    the dialog says that "Open without trust" will not ask.
  - Known limits: a different repo cloned later to the same path inherits trust (binding to the git root commit
    is a follow-up); `projects.json` is writable by hive agents and by the renderer's file IPC, so the flag is a
    consent step, not a boundary; the project folder or local-work file can still be swapped between check and
    use by code already running in the workspace.
- No in-app ZetaHub refresh for now. `runHiddenClaude` runs with `bypassPermissions` and a sync reads ticket text
  that any ZetaHub user can write, so a refresh needs a restricted tool list or a direct client first. The user
  refreshes with `/zetahub-sync`; the panel shows the cache time.
- Reads happen on room open and on window focus. There are no file watchers and no polling.
- Performance rules:
  - At most `roomPtyCap` live room terminals (config, default 3). Opening one more asks to close the least
    recently used.
  - A room terminal that is not on screen and has had no output for `roomIdleMinutes` (config, default 30)
    stops. Its session stays resumable.
  - Room terminals keep 10 000 lines of scrollback.
  - Main coalesces `pty:data` for every PTY (about 16 ms or 64 KB), keeping order and losing nothing.
- Each room also draws two small boards with ticket counts. Clicking a board selects the room.

## Consequences
- Opening a room costs no tokens and starts no process.
- The ZetaHub table is as fresh as the cache; the panel shows "cached as of".
- Config gains `roomPtyCap` and `roomIdleMinutes` with the performance work; missing values fall back to the
  defaults.
- `projects.json` gains `trustedPath` per project; a missing value means not trusted.
- Closing a lead archives it (`teardownPty`), so mail for it waits until its terminal is opened again.
- The session the person resumes becomes the lead's recorded session through the normal hook capture.
- Projects without a `ZetaHub project key:` or `Local open work:` line show an empty-state hint instead of a table.
- The PTY batching changes timing for every terminal; tests cover the flush rules.
- Follow-up: the open `pty:spawn` trust item stays for the other spawn paths.
- Follow-up: an in-app Refresh, once a restricted hidden run or a direct client is chosen.
- Follow-up: "spawn then announce" now exists three times in `index.ts` (voice, worker, room lead); extract it.
