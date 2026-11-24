# 0011. The hook shim owns `agent_id`; a subagent's id moves to `subagent_id`

- **Status**: Accepted
- **Date**: 2026-11-24
- **Scope**: the cth-hook shim (`HOOK_SHIM` in `src/main/hive.ts`), `src/main/hooks.ts`,
  `src/renderer/src/hooks/useHive.ts`. Changes the agent id rule kept by ADR 0008.

## Context
The cth-hook shim kept an `agent_id` Claude already set and used `AGENT_ID` only when there was none (ADR 0008).
Claude Code sets `agent_id` (and `agent_type`) on every hook fired inside a subagent or in-process teammate, and
never on the session's own hooks. Checked live on Claude Code 2.1.330 with an Explore subagent:

| Hook | `agent_id` | `agent_type` |
|---|---|---|
| Lead's PreToolUse/PostToolUse/Stop | absent | absent |
| SubagentStart, the subagent's PreToolUse/PostToolUse, SubagentStop | `a2ea79d51ca8c1558` | `Explore` |

The hook docs say the same ("the input carries the `agent_id` and `agent_type` … that identify the subagent").
So every tool call a subagent made reached main under an id the hive does not know:
- halt, pause and tool gates (`ControlRegistry`) did not apply: a paused or gated lead could still run tools
  through a subagent;
- the breaker never saw those tool calls;
- the hook token check (ADR 0010) found no token for that id and accepted the event unchecked.

SubagentStop was harmless only because its id was unknown: main and the renderer treat it like `Stop`, so under
the lead's id it would mark the lead idle and toast "finished" mid-turn. The Gemini and Grok shims already send
their SubagentStop under the lead's id and have that bug today.

## Options
### A. The shim owns `agent_id`
The shim always sets `agent_id = AGENT_ID` when the spawn has one, and moves an id Claude set to `subagent_id`
(`agent_type` passes through). Main and the renderer treat SubagentStart and SubagentStop as activity, not as the
lead stopping. Pros: one rule, the env var is the identity, every guard covers subagents. Cons: parallel subagents
making identical tool calls count toward the lead's loop detector.

### B. Main resolves an unknown id by its spawn token
No shim change; main maps an unknown `agent_id` to the agent that owns the payload's token. Claude only, and the
token becomes an identity, which is harder to reason about than the env var.

### C. Gates only
Keep the subagent id; apply halt, pause and gates by resolving the lead from the token when `agent_type` is set.
Smallest diff; the breaker and the floor stay blind and identity is split across two rules.

## Decision
We chose **A**:
- `agent_id` is the hive agent whenever `AGENT_ID` is set. Without `AGENT_ID` (a session main did not spawn) the
  shim leaves Claude's payload as it was.
- `subagent_id` carries Claude's id only when Claude set one; main does not key anything on it yet.
- Only `Stop` means the lead stopped. SubagentStop goes through the ordinary path: it is emitted as activity, and
  `workerWake` still counts it as a turn.

## Consequences
- Halt, pause, tool gates, the breaker and the token check now cover tool calls made inside subagents and
  in-process teammates.
- Parallel subagents can trip the lead's identical-tool-call detector sooner. Watch for false trips; if they show
  up, key the loop detector by `(agent_id, subagent_id)`.
- A subagent finishing no longer marks a Gemini or Grok lead idle.
