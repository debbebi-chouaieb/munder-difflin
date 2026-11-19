# 0001. Workspace folder projects, stored per hive

- **Status**: Accepted
- **Date**: 2026-11-19
- **Scope**: project-wide

## Context
The app has no project entity. `Agent.project` is only `basename(cwd)` for display, and the known folders are a flat
`config.registeredRepos: string[]`. We need a left sidebar where each folder of a workspace is a project that can be
enabled or disabled, with a per-project parallel-work switch, and agents grouped into project agents and global
"tech lead" agents.

The target workspace is one root folder (`D:\zetabox`) whose top-level folders are separate repos, some with a
`CLAUDE.md` and a `.claude/agents/` folder of their own.

## Options
### A. Workspace root, each top-level subfolder is a project
Pros: matches how the workspace is already organised; new folders appear without manual steps.
Cons: needs a filter (hidden folders, plain files); the root must be validated in main.
Testing impact: pure discover and merge helpers, easy to unit test.

### B. Keep the registered repos list
Pros: no new concept.
Cons: not a folder tree; every project is added by hand; no place for enabled and parallel flags.

### C. Both a root and extra manual folders
Pros: flexible.
Cons: more UI and more edge cases (duplicates, folders outside the root) for no current need.

### Storage
- `config.json` (global, per machine): simple, but the state would leak across hives.
- `<harnessHome>/projects.json` (per hive, committed like `tasks.json`): follows the hive, history in git.

## Decision
We chose **A**, stored in **`<harnessHome>/projects.json`**, with only `workspaceRoot` in `HarnessConfig`.

- Project = non-hidden top-level directory of `workspaceRoot`. Dot-folders and files are skipped.
- `Project { id, name, path, enabled, parallel, zetahubKey?, leadAgentId? }`; `id` is a slug of the folder name.
- Metadata is read only from the folder: `CLAUDE.md` or `.claude/CLAUDE.md` (a "ZetaHub project key" line if present)
  and `.claude/agents/*.md` (the project's room agents).
- Agents gain `projectId?` and `scope: 'project' | 'global'`. Old agents derive both from `cwd`; the god agent stays
  the CEO; global agents come from `~/.claude/agents/*.md`.
- `registeredRepos` is kept untouched.

## Consequences
- Main must check that every listed or opened path is inside `workspaceRoot`; today `fs:listDir` trusts any root.
- A folder rename looks like a new project; the old entry is kept disabled until removed.
- Switching hives switches the project state with it.
