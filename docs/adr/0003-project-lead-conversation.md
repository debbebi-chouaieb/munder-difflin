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

## Consequences
- Running cost grows with the number of enabled projects; projects are disabled by default on first discovery.
- `fleet.json` and the roster context carry project, scope and lead so the models can route.
