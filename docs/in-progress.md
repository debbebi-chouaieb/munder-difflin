# In progress and known gaps

Update this file whenever a work item starts, finishes, or a new gap appears.

## No ticket yet

munder-difflin has no ZetaHub project, so its work is tracked here as local tickets. The `backlog` skill reads
only this section. One bullet per item: what, then (source, date). Remove a bullet when it is done.

- Phase 0: ADRs 0001-0004 and this local ticket list (plan project-rooms, 2026-11-19)
- Phase 1: project model and workspace: `src/shared/project.ts`, `src/main/projects.ts`, `<harnessHome>/projects.json`, `workspaceRoot` config, `projects:*` IPC, `projectId`/`scope` on agents, path guard (ADR 0001, 2026-11-19)
- Phase 2: left project sidebar with checkboxes, parallel toggle, hide/show with a single reopen icon (ADR 0001, 2026-11-19)
- Phase 3: rooms generated at runtime (CEO, tech leads, one per project) and room lights (ADR 0002, 2026-11-19)
- Phase 4: one project lead conversation per project and parallel work enforced in main (ADR 0003, ADR 0004, 2026-11-19)
- Phase 5: Android devices from `adb devices` in the office and on tasks (ADR 0005 to write at the phase brief, 2026-11-19)
- Privacy: turn off usage analytics (PostHog) and auto-update checks to the upstream project by default (user request, 2026-11-19). Still open: upstream click-through links in Settings and the update toast. Migration of profiles that already saved `true` skipped by decision (review, 2026-11-19)
