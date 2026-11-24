# 0008. A per-spawn token releases the room trust prompt gate

- **Status**: Accepted
- **Date**: 2026-11-23
- **Scope**: the trust prompt gate (`src/shared/claudeTrust.ts`), the hook payload (`HOOK_SHIM` in
  `src/main/hive.ts`, `src/main/hooks.ts`), lead spawn in `src/main/index.ts`

## Context
An untrusted room lead may sit at Claude's startup trust prompt, whose Enter means "yes" (ADR 0005).
`TrustPromptGate` holds the lead's agent id, and the first hook event that proves a turn ran releases it.
The Rooms-e audit found two ways to release it without a real turn:
- A lead keeps its agent id across restarts. A late `Stop` hook from a lead that was just killed can arrive after
  its replacement was held, and release the replacement.
- The hook socket name is derived from the hive root (on Windows a named pipe, `\\.\pipe\munder-difflin-<sha1>`),
  and the payload names the agent itself. Any local process that reaches the socket can send
  `agent_id=lead--x` and release a gate.

## Options
### A. A secret per spawn in the agent's env, echoed in the payload
Main makes 32 random bytes for each guarded spawn and passes them as `HIVE_SPAWN_TOKEN`; the shim adds
`spawn_token` to every payload. The gate stores `agentId → token` and a turn releases it only when the token
matches (constant time). Closes both gaps. Cost: one new payload field. Testing: pure gate unit tests, and the
shim run against a local socket.

### B. A spawn counter, no secret
The gate is keyed by `(agentId, spawnGen)`, passed as `HIVE_SPAWN_GEN`. Closes the late-hook race only: the next
number is guessable, so forging stays open.

### C. A random socket per lead
Each lead's `HIVE_SOCK` names its own unguessable pipe; main knows the agent by the listener. No payload change,
but one listener per lead multiplies the bind, health-check and stale-path handling in `hooks.ts`.

## Decision
We chose **A**, checked only where the gate is released by a turn:
- The token is made only for a spawn whose gate is held, lives in main's memory (never in `registry.json`, the
  hive log or the renderer event), and is replaced on every spawn.
- Main also keeps the token by PTY id, so a closing terminal releases only the spawn it belongs to, even if a
  later spawn of the same lead holds the gate by then.
- The shim's agent id rule is unchanged: `AGENT_ID` only when Claude's payload has no `agent_id`.

## Consequences
- A process running as the same OS user can still read the lead's environment, or edit `~/.claude.json`
  directly; the token does not defend against it. It stops stale hooks and blind forgery.
- The lead's own child processes (MCP servers, the repo's hooks) inherit the token. They only start once the
  person answered the trust prompt, after which the gate has no job left.
- The lead can print its environment, so the token may end up in its transcript. That is after trust, the gate
  is already released, and the next spawn gets a new token.
- Other hook paths (pause, halt, breaker, inbox) still trust the payload's `agent_id`. Closed by ADR 0010: every
  spawn now has a token, checked on every hook.
