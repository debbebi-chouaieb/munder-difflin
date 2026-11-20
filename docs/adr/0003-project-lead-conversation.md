# 0003. One conversation per project through a project lead agent

- **Status**: Accepted
- **Date**: 2026-11-19
- **Scope**: project-wide

## Context
Each agent has its own CLI session, captured by hooks (`recordSession`) and resumed with `--resume`. The god agent
(the CEO's clone) routes work between agents by mail files. We want exactly one conversation per project that
survives restarts.

## Options
### A. A project lead agent per enabled project
Its resumed terminal session is the project conversation. It delegates to the project's room agents. The CEO and
the tech leads talk to the lead.
Pros: reuses the session, resume and transcript machinery; each project keeps its own context.
Cons: one more running CLI per enabled project (cost and memory).

### B. A project thread routed through the god agent
Pros: no extra agent. Cons: the god agent's context mixes every project; no real per-project session.

## Decision
We chose **A**.

- Enabling a project ensures its lead exists (`role: lead`, `cwd` = project path, `resume: true`), following the god
  agent's boot path. Its id is stored as `leadAgentId` in `projects.json`.
- Disabling a project puts its agents on hold. Nothing is killed or deleted, so re-enabling resumes the session.
- Selecting a project in the sidebar opens the lead's terminal.
- The god prompt routes project work to the lead; the lead prompt delegates inside its project.

### Amendment (2026-11-20, ADR 0005)
- Enabling a project creates nothing. The lead's registry record and PTY are created on the first open from the
  project room (`room:openTerminal`).
- The user picks which session to resume from the room's session list, or starts a new one. Hook capture then
  records it as the lead's session, as for any agent.
- A lead runs with folder-trust pre-accept and auto mode only for a project the user trusted (ADR 0005).
- Clicking the project room opens the RoomPanel (ADR 0005), which hosts the lead's terminal. Selecting a project in
  the sidebar is no longer the trigger.
- At most `roomPtyCap` (default 3) lead terminals run at once, and idle ones that are not on screen stop after
  `roomIdleMinutes` (default 30).

## Consequences
- Running cost grows with the number of enabled projects; projects are disabled by default on first discovery.
- `fleet.json` and the roster context carry project, scope and lead so the models can route.
