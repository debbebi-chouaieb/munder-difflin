# In progress and known gaps

Update this file whenever a work item starts, finishes, or a new gap appears.

## No ticket yet

munder-difflin has no ZetaHub project, so its work is tracked here as local tickets. The `backlog` skill reads
only this section. One bullet per item: what, then (source, date). Remove a bullet when it is done.

- Phase 3: rooms generated at runtime (CEO, tech leads, one per project) and room lights (ADR 0002, 2026-11-19)
- Phase 4: one project lead conversation per project and parallel work enforced in main; adds `projectId`/`scope` on agents (ADR 0003, ADR 0004, 2026-11-19)
- Phase 4 also: project picker in AddAgentModal (projects list + global option); explicit projectId so agents in worktrees count in their room (deferred from Phase 2, 2026-11-19)
- Phase 5: Android devices from `adb devices` in the office and on tasks (ADR 0005 to write at the phase brief, 2026-11-19)
- Confine `fs:listDir`/`fs:readFile`/`fs:writeFile` to known roots (workspace projects, agent cwds); today they accept any renderer-chosen root, and UNC roots are not refused. Must land before Phase 4 (security audit of Phase 1, 2026-11-19)
- Privacy: upstream click-through links in Settings and the update toast still point at the upstream project. Migration of profiles that already saved `true` skipped by decision (review, 2026-11-19)
- Native modules (node-pty, better-sqlite3) not rebuilt on this machine: needs Visual Studio 2022 Build Tools with the C++ workload, then `npm rebuild` (2026-11-19)
- 7 focused tests fail on upstream HEAD too (agent-token-cap, arabic-terminal, hire-import, model-catalog-remote, provider-config, release-notes, telemetry-message-count); 16 more fail on this Windows machine for symlink EPERM and socket EACCES (2026-11-19)
- Right-hand agent sidebar splitter drags the wrong way in an RTL (Arabic) layout; pre-existing, kept unchanged in Phase 2 (review, 2026-11-19)
- Stored sidebar widths are only re-clamped on drag: opening the project menu next to a very wide agent sidebar can still squeeze the floor until either is dragged (review, 2026-11-19)
- Michael boot sends /remote-control, which fails with "Session creation failed (server 400)"; upstream behavior, not investigated (2026-11-19)
