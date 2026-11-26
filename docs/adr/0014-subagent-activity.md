# 0014. Agent lists show which subagents are running

- **Status**: Accepted
- **Date**: 2026-11-26
- **Scope**: Claude hook registration (`src/main/hive.ts`), `src/main/hooks.ts`, `HookEvent` in
  `src/shared/hookEvents.ts`, a new `src/shared/subagentActivity.ts`, a renderer store slice, the sidebar's Tech
  leads and Desks rows.

## Context
Tech leads (global agents) and Desks (project agents) are definitions that a live session calls through its Agent
tool. Their rows are always `○`; nothing shows that Michael or a room lead is running one right now.

Claude fires `SubagentStart` and `SubagentStop` with `agent_id` and `agent_type` (ADR 0011's table; `agent_type`
is the definition's frontmatter `name`). Since ADR 0011 the shim moves that id to `subagent_id` and sets
`agent_id` to the hive agent. But Claude spawns do not register `SubagentStart`, and `HookEvent`, the shape that
crosses into the renderer, drops both `subagent_id` and `agent_type`.

## Options
### A. Signal: SubagentStart/SubagentStop hooks
Register `SubagentStart` for Claude spawns and carry `subagentId` and `subagentType` on `HookEvent`. Exact, and
covers background subagents. Costs one more hook process per subagent start.

### B. Signal: the Agent tool's PreToolUse/PostToolUse
No new hook; read `subagent_type` from the tool input. A background subagent's PostToolUse returns at once, so it
would show as finished while it still works.

### C. State in main, pushed over a new IPC
Survives a renderer reload, but adds a channel and push/pull logic for state that is display-only.

### D. State in the renderer store
A slice keyed by hive agent id, fed from `hive:hookEvent`. No new IPC; a reload starts empty, which only hides runs
that began before it.

### E. Matching: every row named T lights
Simple, but a `reviewer` run for one project lights every project's `reviewer`.

### F. Matching: Claude's shadowing rule
A project agent wins over a user agent of the same name for sessions in that project.

## Decision
We chose **A + D + F**:
- Claude spawns register `SubagentStart`. `HookEvent` gains optional `subagentId` (1–64 chars of `[A-Za-z0-9_-]`)
  and `subagentType` (an agent name per ADR 0009); main sends them only when they are valid, and the validator
  rejects anything else.
- The renderer keeps `running: { [hiveAgentId]: { [subagentId]: type } }`. `SubagentStart` adds, `SubagentStop`
  removes, and the agent's next `SessionStart` (a respawn or `/clear`) drops its entry. Only agents with a live
  terminal count when rows are lit. A lead's `Stop` does not clear it: background subagents outlive the turn.
- A pure `activeAgentRows(running, live, projects, globals)` decides the rows: a run by project P's lead whose type P
  defines lights P's desk; any other run whose type is a global agent lights that Tech leads row; built-in or
  unknown types (Explore, plugin agents) light nothing. Lit rows show `●` instead of `○`.

## Consequences
- Codex, Gemini and Grok spawns are unchanged; their subagents do not light rows.
- A `SubagentStop` that never arrives (a killed process mid-run) leaves a row lit until that hive agent's terminal
  closes or it starts a new session.
- Matching is by frontmatter `name`, so it relies on ADR 0013 for global agents.
