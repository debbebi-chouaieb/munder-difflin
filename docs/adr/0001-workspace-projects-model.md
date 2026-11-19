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
- `<harnessHome>/hive/projects.json` (per hive, committed by the hive's git like `tasks.json`): follows the hive,
  history in git.

## Decision
We chose **A**, stored in **`<harnessHome>/hive/projects.json`**, with only `workspaceRoot` in `HarnessConfig`.

- Project = non-hidden, non-symlink top-level **git repo** of `workspaceRoot`. Dot-folders, plain folders
  (no `.git`), links and junctions, and files are skipped (user decision 2026-11-19: parallel mode needs worktrees).
- `workspaceRoot` starts empty and is set only through the native folder dialog in the sidebar
  (`projects:pickWorkspace`). It must be a local absolute folder (network paths are refused). The generic
  `config:update` strips it, so the renderer never sends a path.
- New projects start disabled and serial. A project's own agents are desks started on demand.
- Stored per project: `{ enabled, parallel, zetahubKey?, leadAgentId? }`, keyed by `id` (a slug of the folder name;
  same-slug folders get `-2`, `-3` in code-point order).
- Served per project: id, name, path, enabled, parallel, `zetahubKey` and its source (`user` overrides `claude-md`),
  `hasClaudeMd`, and `agents`. CLAUDE.md contents never leave main.
- Metadata is read only from the folder: `CLAUDE.md` or `.claude/CLAUDE.md` (a "ZetaHub project key" line whose value
  is back-ticked or upper case) and `.claude/agents/*.md` (the project's room agents). Linked files are not read.
- The god agent stays the CEO; global agents come from `~/.claude/agents/*.md`. Mapping agents to projects (from
  `cwd`, then explicit `projectId`/`scope` fields for leads and worktree agents) arrives with the phases that use it.
- `registeredRepos` is kept untouched.

## Consequences
- Folders are scanned at startup and on `projects:rescan` (a Rescan action in the sidebar, Phase 2). There is no
  live folder watcher: `fs.watch` is unreliable on Windows.
- A folder rename looks like a new project. The old entry stays in the file unchanged and comes back if the folder
  does; there is no removal action yet.
- A `projects.json` that is not valid JSON is moved aside as `projects.json.bad-<time>`; one that cannot be read
  blocks writes, so a toggle never wipes the other projects.
- Switching hives switches the project state with it.
- Deferred: `fs:listDir`/`fs:readFile` still accept a renderer-chosen root. Confining them to the workspace is
  tracked in `docs/in-progress.md` and must land before lead agents run in project folders (Phase 4).
