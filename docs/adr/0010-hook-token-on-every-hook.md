# 0010. Every spawn's hook events carry its token

- **Status**: Accepted
- **Date**: 2026-11-24
- **Scope**: spawn in `src/main/index.ts` (`spawnAgentCore`), the hook server (`src/main/hooks.ts`), every hook
  sender in `src/main/hive.ts` (cth-hook, agy, Gemini, Grok, proxy bridge, Pi extension, OpenCode plugin), the new
  `src/main/spawnTokens.ts`. Extends ADR 0008.

## Context
ADR 0008 gave guarded room lead spawns a `HIVE_SPAWN_TOKEN` and checks it only where a turn releases the trust
prompt gate. Every other hook path still trusts the payload's `agent_id`. Any local process that reaches the hook
socket (its name is derived from the hive root) can send `agent_id=<some agent>` and:
- drain that agent's inbox on `Stop`, taking its messages;
- overwrite its recorded session id (`recordSession`), so a later `--resume` opens the wrong session;
- feed its circuit breaker repeated tool calls and trip it;
- push false state for it to the floor.

Pause and halt only change the reply to the sender, so forging them gains nothing. Seven senders post to the socket,
not five: the cth-hook shim (Claude and Codex), agy, Gemini, Grok, the proxy bridge sidecar (Crush, Qwen), the Pi
extension and the OpenCode plugin. They all run inside, or are started for, an agent spawned by `spawnAgentCore`.

## Options
### A. A token for every spawn, checked when one was issued
`spawnAgentCore` mints a token for every spawn with hive metadata, passes it as `HIVE_SPAWN_TOKEN` (and to the proxy
sidecar), and records `agentId → token` once the PTY started. Every sender forwards it as `spawn_token`. The hook
server drops an event whose agent has a token on record and whose payload has none or a different one. Agents with
no token on record are accepted as before.
Pros: covers the whole fleet, one rule in one place. Cons: all seven senders change. Testing: pure registry tests,
hook server tests for drop and accept, each sender run against a local socket.

### B. Room leads only
Keep tokens on guarded lead spawns, check them in every path for those agents. Small diff; ordinary agents and
non-Claude leads stay forgeable.

### C. Always strict
Drop every event without a valid token. Strongest rule, but anything that posts without a token (a sender missed
here, a hook fired by a process main never spawned) goes silent with no clear cause.

## Decision
We chose **A**:
- The token is 32 random bytes, minted per spawn, kept only in main's memory (never in `registry.json`, the hive
  log, or a renderer event) and replaced on every spawn of that agent id. It is recorded only after the PTY started,
  so a failed spawn leaves the previous token in place.
- A dead spawn's token stays on record until the next spawn replaces it: a forged event for a stopped agent is still
  dropped. The token map is bounded by the number of agent ids.
- A dropped event touches no state (no inbox, no session record, no breaker feed, no emit, no `onEvent`) and writes
  a `hook-token-rejected` log line with the agent id and event name, never the token. A dropped `PreToolUse` is
  answered with a deny, so a sender that lost the token fails closed instead of running tools unguarded; every
  other dropped event gets `{}`. A forger only denies itself.
- The trust prompt gate (ADR 0008) reuses the same token, so a guarded lead has one secret, not two.
- Hook events whose `agent_id` Claude set itself (subagents) are keyed by that id; main never issued a token for it,
  so they are accepted as before.

## Consequences
- Same-user processes can still read an agent's environment; as in ADR 0008, this stops stale hooks and blind
  forgery, not a local attacker running as the user.
- Agents spawned before this change do not exist after a restart (PTYs die with the app), so there is no migration.
- The OTel collector still trusts `agent.id` from resource attributes; it only feeds cost and token telemetry and is
  out of this scope.
- The proxy bridge sidecar starts with the new token during hive provisioning, before the PTY. If the spawn then
  fails, that sidecar is left with a token never issued and its events are dropped; it only posts on LLM traffic
  from a CLI that did not start, so nothing is lost in practice.
- A new sender must forward `HIVE_SPAWN_TOKEN`, or its events are dropped once main has issued a token for the agent.
