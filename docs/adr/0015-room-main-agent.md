# 0015. A room's lead can run as one of the listed agents; agent files open in the editor or go to the trash

- **Status**: Accepted
- **Date**: 2026-11-26
- **Scope**: `StoredProject` / `Project` in `src/shared/project.ts`, a new `src/shared/mainAgent.ts`, the project
  scan (`src/main/projects.ts`), the lead spawn in `spawnAgentCore` (`src/main/index.ts`), a new
  `src/main/agentFiles.ts`, the room panel's agent list and the sidebar's Tech leads. Extends ADR 0003, 0009 and 0013.

## Context
A room's lead (ADR 0003) is always plain `claude` plus the hive protocol, with the role `lead`. Many projects already
define the agent their main session should be: an agent in `.claude/agents`, or one in the user's global folder. The
person wants the room lead to *be* that agent instead of a generic one, in a way that works for any project, not only
ones whose CLAUDE.md happens to describe a lead. The person also wants to change or remove agent definitions from the
panel.

Claude Code already has a structured way to say this: the `agent` setting in `.claude/settings(.local).json` and the
`--agent <name>` flag, which overrides the setting. A spike showed that `--append-system-prompt` (the hive protocol)
still applies under `--agent`: the session took the agent's persona and kept the appended text.

Card restart and Restore team replay renderer-built args through `pty:spawn`. So a choice passed only by the room's
open would be lost on restart, the same reason lead trust is decided in `spawnAgentCore` (ADR 0005).

## Options
### A. Room choice in `projects.json`, then the repo's `agent` setting, then the hive default
Pros: works for every project; nothing is written into the repo; Claude applies the repo setting itself.
Cons: one more stored field; the app must keep `--agent` out of replayed args.

### B. Write `agent` into the repo's `.claude/settings.local.json`
Pros: one source of truth, exactly Claude's. Cons: the app writes into repos; a plain `claude` started outside the app
inherits the choice.

### C. The repo's `agent` setting only
Pros: smallest. Cons: a project without one cannot get a chosen lead without editing its files.

Reading a lead from CLAUDE.md prose was rejected: it is a guess and fits only one way of writing CLAUDE.md.

For editing: open the file in the person's editor, or a built-in editor. A built-in one needs a new write path into
repos and frontmatter validation on save.

## Decision
**A**, and agent files are **opened in the default editor or moved to the trash**.

- `StoredProject.mainAgent` is `{ scope: 'project' | 'global', file }`, the definition's stable key (ADR 0009).
  `null` in a patch removes it.
- The scan also reads the `agent` key of the project's `.claude/settings.local.json`, else `.claude/settings.json`
  (plain files, at most 64 KiB, a valid agent name or nothing) as `Project.settingsAgent`, so the panel can show it.
- A pure resolver gives the room's lead agent: the room choice when its definition is still listed (and, for a
  global one, no project agent shadows its name), else the repo setting, else the hive default. Only a room choice
  adds a flag; Claude applies the repo setting by itself.
- `spawnAgentCore` decides it for every Claude lead spawn, from the snapshot it already waits for (`leadAgentOf`):
  it removes every flag that can define agents or settings (`--agent`, `--agents`, `--settings`, `--setting-sources`,
  `--plugin-dir`) from the replayed args, then adds `--agent <name>` for a room choice. Main's own hook `--settings`
  is added after that. A choice whose file is gone spawns without it, and the panel says so.
- The room choice applies only when the spawn's folder is the project's own folder, so a lead id cannot carry it
  into another folder. A project-scope choice applies only to a trusted lead: a repo agent's frontmatter can set
  permissions, hooks and MCP servers, so it gets the same gate as auto mode (ADR 0005). The panel says so. The user's
  global agents apply either way.
- A global choice needs the scan to have seen every name Claude could load from the repo: `.claude` and
  `.claude/agents` are real folders (or absent), hold only plain `.md` files with valid names within the cap, and
  every file's frontmatter `name` was read. When not, no global agent can be chosen and a stored one counts as
  missing: a repo agent we did not read could carry its name. Names are compared without regard to case.
- A linked `.claude` folder is not followed: the scan reads no agents, settings or `.claude/CLAUDE.md` through it
  (and then no global agent can lead, since Claude may still load agents through it), and open and trash refuse it.
- `AgentDefinition.delegates` is false when the frontmatter `tools` line is present and names neither `Agent` nor
  `Task`; the panel warns that such a lead cannot hand work to subagents. It is still allowed.
- A choice whose name another file in the same folder also declares is ambiguous: `--agent` could run either, so the
  lead starts without it and the panel says so. A global choice shadowed by a project agent of the same name counts
  as missing, since Claude would run the project one.
- A change applies on the lead's next start. A running lead keeps its persona, and the panel says so.
- `agents:open` and `agents:trash` take a scope, a project id (project scope) and a file key. Main builds the path
  from the project folder or the global folder, requires the key in the current snapshot, a real `agents` folder and
  a plain `.md` file (`lstat`), then calls `shell.openPath` or `shell.trashItem`; a trash rescans. The fixed `.md`
  extension is why `openPath` is acceptable here, unlike for paths printed by agents (`fs:revealPath`). The panel
  asks before trashing.

## Consequences
- The lead's role in the hive stays `lead`; its persona comes from the agent file.
- A trashed agent can be restored from the OS trash. A room choice that pointed at it shows as missing until changed.
- Same residual as ADR 0009: between the `lstat` and the open or trash, a file can be swapped for a link.
- The sidebar's Tech leads rows (global agents, ADR 0013) get the same Open and Remove (amended 2026-11-27). Their
  trash warning counts the rooms whose lead chose that agent.
- Creating agents is left for later.
