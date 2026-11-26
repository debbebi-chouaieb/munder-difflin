# In progress and known gaps

Update this file whenever a work item starts, finishes, or a new gap appears.

## No ticket yet

munder-difflin has no ZetaHub project, so its work is tracked here as local tickets. The `backlog` skill reads
only this section. One bullet per item: what, then (source, date). Remove a bullet when it is done.

- Rooms forget trust: `pty:spawn` (Restore team, card restart) can start a lead while `room:forgetTrust` runs; it skips the forget lock, and its pre-accept can race the `~/.claude.json` rewrite and leave Claude's folder trust. Share a per-project lock with spawnAgentCore's lead branch; fits the pty:spawn trust review (from Forget trust audit, 2026-11-26)
- Rooms orphaned Claude trust: when main's own revokeTrust (stale repo, failed spawn) drops stored trust but cannot write `~/.claude.json`, the app-written folder trust stays and no button can clear it (project reads untrusted). Retry on the next open or forget (from Forget trust audit, 2026-11-26)
- Rooms tests: no behaviour test drives the Forget trust button in RoomPanel; only `canForgetTrust` is tested (from Forget trust review, 2026-11-26)
- Rooms small: the room panel and the board-count hook both read tickets on window focus (one extra read); the `hive:agentSpawned` payload is built in roomWiring.announceLead and three spawn-then-announce copies in index.ts: one builder in shared/roomLead.ts (Rooms-e review, 2026-11-23)
- Rooms limits UI: `roomPtyCap` and `roomIdleMinutes` are config-file only; add them to Settings if people need to change them. The cap counts least recently used by last room open or write, both reset on app restart (Rooms-d, 2026-11-23)
- Rooms local tickets on Windows: no O_NOFOLLOW, so the open of a file link swapped in after the lstat walk can still touch a network share (content is never read); a parent junction under the workspace root is followed by `resolveAllowedRoot` before the network check (Rooms-e audit, 2026-11-23)
- Rooms tests: the lead-trust wiring in spawnAgentCore is still pinned by source regexes (room-ipc.test.cjs wiring test); extract a pure `decideLeadTrust(opts, projects)` and test it directly. No behaviour test yet for the useHive seed hold or for a restored lead without `ptyId` (refused by leadIdOfSpawn) (Rooms-e review, 2026-11-23)
- Rooms ZetaHub key: a repo's CLAUDE.md picks the key, so a hostile repo can show another project's cached tickets in its room; prefer the user key or show the key source in the room (Rooms-e audit, 2026-11-23)
- worktree-deps.test.cjs: 5 tests fail on Windows with a trailing backslash on the linked node_modules path (not symlink EPERM); `npm run test:focused` does not expand `test/*.test.cjs` on Windows (Rooms-e test run, 2026-11-23)
- Rooms refresh (deferred): in-app ZetaHub refresh. `runHiddenClaude` uses bypassPermissions while a sync reads user-written ticket text; needs a restricted tool list or a direct client first (pm review, 2026-11-20)
- Phase 4: parallel work enforced in main; adds `projectId`/`scope` on agents. The lead conversation part moved to Rooms-b/c (ADR 0004, 2026-11-20)
- Phase 4 also: project picker in AddAgentModal (projects list + global option); explicit projectId so agents in worktrees count in their room (deferred from Phase 2, 2026-11-19)
- Phase 6: Android devices from `adb devices` in the office and on tasks (its ADR takes the next free number at the phase brief; 0005 to 0008 went to the rooms, 2026-11-23)
- Privacy: upstream click-through links in Settings and the update toast still point at the upstream project. Migration of profiles that already saved `true` skipped by decision (review, 2026-11-19)
- 7 focused tests fail on upstream HEAD too (agent-token-cap, arabic-terminal, hire-import, model-catalog-remote, provider-config, release-notes, telemetry-message-count); 16 more fail on this Windows machine for symlink EPERM and socket EACCES (2026-11-19)
- Source-regex tests that hard-code a bare LF (e.g. telemetry-message-count steer and composer) pass or fail with the checkout's line endings (core.autocrlf=true gives CRLF); match an optional CR before each LF, or add a `.gitattributes` eol rule (2026-11-20)
- quit-sweep.electron.test.cjs failed once in a full run under heavy machine load and passed 3 of 3 alone; watch for flakiness (2026-11-20)
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
