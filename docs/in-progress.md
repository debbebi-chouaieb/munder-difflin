# In progress and known gaps

Update this file whenever a work item starts, finishes, or a new gap appears.

## No ticket yet

munder-difflin has no ZetaHub project, so its work is tracked here as local tickets. The `backlog` skill reads
only this section. One bullet per item: what, then (source, date). Remove a bullet when it is done.

- Rooms-b: main readers and IPC with tests: `room:sessions`, `room:tickets`, `room:openTerminal`, `room:closeTerminal` (project id only), per-project trust (ADR 0005, 2026-11-20)
- Rooms-c: room click, RoomPanel (sessions, lazy lead terminal, ZetaHub and local tables), two count boards per room, en/ar/zh-CN (ADR 0005, ADR 0003 amended, 2026-11-20)
- Rooms-d: PTY performance: `pty:data` coalescing for all PTYs, room scrollback 10 000, room terminal cap, idle shutdown, config `roomPtyCap`/`roomIdleMinutes` (ADR 0005, 2026-11-20)
- Rooms-e: reviewer and security-auditor on `room:*` IPC, lead spawn and the `~/.claude` reads; test-runner against the known failing list (ADR 0005, 2026-11-20)
- Rooms trust follow-ups: bind `trustedPath` to the git root commit so a re-clone at the same path asks again; extract the three "spawn then announce" copies in index.ts; re-check the lead cwd right before ptyManager.spawn (security audit, 2026-11-20)
- Rooms refresh (deferred): in-app ZetaHub refresh. `runHiddenClaude` uses bypassPermissions while a sync reads user-written ticket text; needs a restricted tool list or a direct client first (pm review, 2026-11-20)
- Phase 4: parallel work enforced in main; adds `projectId`/`scope` on agents. The lead conversation part moved to Rooms-b/c (ADR 0004, 2026-11-20)
- Phase 4 also: project picker in AddAgentModal (projects list + global option); explicit projectId so agents in worktrees count in their room (deferred from Phase 2, 2026-11-19)
- Phase 6: Android devices from `adb devices` in the office and on tasks (ADR 0006 to write at the phase brief; 0005 went to the room panel, 2026-11-20)
- Privacy: upstream click-through links in Settings and the update toast still point at the upstream project. Migration of profiles that already saved `true` skipped by decision (review, 2026-11-19)
- 7 focused tests fail on upstream HEAD too (agent-token-cap, arabic-terminal, hire-import, model-catalog-remote, provider-config, release-notes, telemetry-message-count); 16 more fail on this Windows machine for symlink EPERM and socket EACCES (2026-11-19)
- Agent sidebar width limits (320/1200, reset 420) are repeated in store.ts, SidebarSplitter defaults and splitterRules; move them next to the project sidebar constants. Floor budget uses window width, not the real row (padding and handles) (review, 2026-11-20)
- Michael boot sends /remote-control, which fails with "Session creation failed (server 400)"; upstream behavior, not investigated (2026-11-19)
- Projects floor camera: zoom/pan bounds for large floors, counter-scaled room labels, center a room when its project is clicked in the sidebar (deferred from Phase 3, ADR 0002, 2026-11-19)
- Projects floor art: errand props (plants, windows, fridge), café furniture, clock art for the clock-to-quit hotspot; tests for RoomLights easing and the useProjectFloor leave-fade timing (review of Phase 3, 2026-11-19)
- HIGH: kg:ingestFiles reads any local file path the renderer sends (then kg:get/kg:search return it). Replace path IPC with dialog-only kg:addFiles plus drag-and-drop through webUtils.getPathForFile and a main-side token (security audit, 2026-11-19)
- config:update and config:changeHome still let the renderer set registeredRepos and harnessHome, which feed the fs/git allowlist; make them main-owned (dialog only) like workspaceRoot (security audit, 2026-11-19)
- git:diff/git:showFile resolve relPath from the repo top level, not the agent folder: use `${rev}:./${relPath}` and keep the top level inside an allowed root (security audit, 2026-11-19)
- runGit honours repo-local config (core.fsmonitor, hooksPath): pass -c core.fsmonitor=false -c core.hooksPath= for read-only git calls (security audit, pre-existing, 2026-11-19)
- A symlink inside an allowed folder whose target is a network path still reaches the network on realpath/stat; walk links with lstat/readlink first (security audit, 2026-11-19)
- pty:spawn accepts a renderer-chosen command and cwd, and a spawned cwd becomes a known root: the fs/git allowlist is only as strong as pty:spawn. Review spawn trust before Phase 4 leads (security audit, 2026-11-19)
- skills:local scans any local absolute cwd without the known-roots check (low) (security audit, 2026-11-19)
- Stopped isolated agents: their original repo is a known root only while main runs (worktreeOrigins); store it in the registry so the IDE git panes keep working after a restart (security audit, 2026-11-19)
