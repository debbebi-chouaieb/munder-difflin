# 0004. Per-project parallel work switch, enforced in main

- **Status**: Accepted
- **Date**: 2026-11-19
- **Scope**: project-wide

## Context
Nothing limits how many agents work in the same project at once. `maxConcurrentWorkers` caps only the god agent's
temporary workers, floor-wide. `onHold` is advisory text in the roster context. Two agents editing the same
checkout at the same time can overwrite each other's changes.

## Options
### A. Enforced in main
When `parallel` is off and another agent of the project is busy, the router (`routeOnce`) keeps new messages in
the outbox and the spawn-request intake waits, until that agent is idle.
Pros: guaranteed; one place for the rule. Cons: delayed messages must stay visible so they do not look lost.

### B. Advisory only
The flag is shown to the models in the roster context. Pros: cheap. Cons: not guaranteed.

### C. Both
Enforce in main and tell the models.

## Decision
We chose **A**. The rule is one pure function, `canDispatch(project, agents)` in `src/shared/`, used by the router,
the spawn-request intake and the renderer queue drain.

- When `parallel` is on, new agents of that project default to git worktree isolation.
- The flag is still shown in the roster context, so the models know why a message waits.

## Consequences
- "Busy" must be defined from the agent status the main process sees (fleet snapshot), not from renderer-only state.
- Tests cover hold and release with a temporary hive folder.
