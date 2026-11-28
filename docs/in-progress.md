# In progress and known gaps

Update this file whenever a work item starts, finishes, or a new gap appears.

## No ticket yet

munder-difflin has no ZetaHub project, so its work is tracked here as local tickets. The `backlog` skill reads
only this section. One bullet per item: what, then (source, date). Remove a bullet when it is done.

- Rooms tests: no behaviour test drives the Forget trust button in RoomPanel; only `canForgetTrust` is tested (from Forget trust review, 2026-11-26)
- Rooms small: the room panel and the board-count hook both read tickets on window focus (one extra read); the `hive:agentSpawned` payload is built in roomWiring.announceLead and three spawn-then-announce copies in index.ts: one builder in shared/roomLead.ts (Rooms-e review, 2026-11-23)
- Rooms limits UI: `roomPtyCap` and `roomIdleMinutes` are config-file only; add them to Settings if people need to change them. The cap counts least recently used by last room open or write, both reset on app restart (Rooms-d, 2026-11-23)
- Rooms local tickets on Windows: no O_NOFOLLOW, so the open of a file link swapped in after the lstat walk can still touch a network share (content is never read); a parent junction under the workspace root is followed by `resolveAllowedRoot` before the network check (Rooms-e audit, 2026-11-23)
- Rooms tests: the lead-trust wiring in spawnAgentCore is still pinned by source regexes (room-ipc.test.cjs wiring test); extract a pure `decideLeadTrust(opts, projects)` and test it directly. No behaviour test yet for the useHive seed hold or for a restored lead without `ptyId` (refused by leadIdOfSpawn) (Rooms-e review, 2026-11-23)
- Rooms ticket details: the details dialog shows no description; the ZetaHub cache has none. Needs `zetahub-cache.sh` to store descriptions or the in-app refresh (ADR 0016 option B, 2026-11-25)
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
- runGit honours repo-local config: `core.fsmonitor` is now off on every call and the worktree diff check skips external diff and textconv (2026-11-28). Still open: hooks run on `worktree add` and `switch`, and clean/smudge filter drivers can run on status and checkout (security audit, pre-existing, 2026-11-19)
- A symlink inside an allowed folder whose target is a network path still reaches the network on realpath/stat; walk links with lstat/readlink first (security audit, 2026-11-19)
- pty:spawn still takes a renderer-chosen command, args, cwd and provider for every agent but a room lead (ADR 0019); env and shellScript are no longer accepted (2026-11-28). A spawned cwd becomes a known root (live pty cwds and registry cwds), and args can add `--dangerously-skip-permissions` with auto mode off. Next: main builds every spawn recipe and only main-set folders become roots; depends on main-owned registeredRepos/harnessHome (security audit, 2026-11-19 and 2026-11-28)
- skills:local scans any local absolute cwd without the known-roots check (low) (security audit, 2026-11-19)
- Stopped isolated agents: their original repo is a known root only while main runs (worktreeOrigins); store it in the registry so the IDE git panes keep working after a restart (security audit, 2026-11-19)
