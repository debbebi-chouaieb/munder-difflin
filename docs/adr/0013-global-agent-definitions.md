# 0013. Global agents carry name, model and description, read from Claude's config folder

- **Status**: Accepted
- **Date**: 2026-11-26
- **Scope**: the project scan (`src/main/projects.ts`), `ProjectsSnapshot.globalAgents` in `src/shared/project.ts`,
  the sidebar's Tech leads section. Extends ADR 0009 to global agents.

## Context
ADR 0009 gave project agents their frontmatter `name`, `model` and `description` and left global agents
(`~/.claude/agents`) as bare file names because "no view asked for more yet". Now one does: the Tech leads list
should read like the Desks list (`reviewer · sonnet`, description as a tooltip). Subagent activity (ADR 0014) also
needs the frontmatter `name`, because Claude reports a subagent by that name rather than by its file name.

The scan also reads the global folder from `homedir()/.claude/agents`. When `CLAUDE_CONFIG_DIR` is set, every
spawned `claude` keeps it (`ptyEnv.ts`) and loads its user agents from `$CLAUDE_CONFIG_DIR/agents`. So the list and
what the agents can actually call would be two different folders.

## Options
### A. Same reader and parser as project agents
`globalAgents` becomes `AgentDefinition[]` and is read through the same `agentHeads` + `agentDefinitionsFrom`
path with the same caps. Pros: one code path and one set of limits; every view gets the same shape. Cons: changes
the snapshot shape again (renderer and tests).

### B. Separate light read for globals
Keep `string[]` and add a `globalAgentModels` map. Pros: no change for consumers of names. Cons: two parallel
fields that can drift; it duplicates ADR 0009's reader.

## Decision
We chose **A**:
- `ProjectsSnapshot.globalAgents` is `AgentDefinition[]`, read with ADR 0009's caps (8 KiB head, 100 files, plain
  files in a real folder). `agentNamesFrom` goes away.
- The global folder is `<CLAUDE_CONFIG_DIR>/agents` when that variable is a local absolute path, else
  `~/.claude/agents`, resolved by a pure `globalAgentsDirFor(env, home)`.
- The Tech leads rows show `name · model`, with the description (or the existing hint) as a tooltip.

## Consequences
- The global folder is the user's own, but it goes through the same untrusted-text cleaning anyway: one rule.
- A relative or network `CLAUDE_CONFIG_DIR` falls back to `~/.claude/agents` and so may not match the agents'
  folder; Claude would resolve a relative value against each agent's cwd, which no single list can show.
- The scan still runs at startup and on Rescan only; watching the folders stays a separate decision.
