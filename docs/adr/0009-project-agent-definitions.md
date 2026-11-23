# 0009. Project agents carry name, model and description from their frontmatter

- **Status**: Accepted
- **Date**: 2026-11-23
- **Scope**: the project scan (`src/main/projects.ts`), `Project.agents` in `src/shared/project.ts`, a new
  `src/shared/agentDefinition.ts`, the project row and the room panel

## Context
The project scan lists `<project>/.claude/agents/*.md` by file name only. The person wants each project's agents
shown with the name and model their definition declares, in the sidebar's project row and in the room panel.
Those files come from a repo that may not be trusted (ADR 0005, 0007): what is read from them must be bounded,
cleaned, and never followed through links.

## Options
### A. Parse the frontmatter in the scan
Main reads a capped head of each agent file; a small strict parser in `src/shared` reads `name`, `model` and
`description`. `Project.agents` becomes a list of definitions. Pros: one read per scan, every view gets the same
data. Cons: changes the snapshot main sends to the renderer.

### B. As A, model limited to known values
Only `opus`, `sonnet`, `haiku`, `fable`, `inherit` or a `claude-…` model id are kept.

### C. Read on demand
The scan stays names only; a new IPC reads one agent's frontmatter when it is shown. Pros: cheaper scan. Cons:
a new IPC and a loading state in each view.

## Decision
**A with B's model check.**
- `Project.agents` is `AgentDefinition[]`: `{ file, name, model, description }`. `file` is the name taken from the
  file name (the stable key); `name` is the frontmatter `name` when it is a valid agent name, else `file`.
- Main reads at most the first 8 KiB of at most 100 `.md` files per project, plain files only (`lstat`), in a
  real `.claude/agents` folder. A head without a closing `---` within those bytes counts as no frontmatter.
- The parser takes top-level `key: value` lines, plain or quoted. A block scalar, a duplicate key or anything
  else it does not understand gives `null` for that key rather than a guess. No YAML dependency.
- `model` is `null` when absent or not a known value. `description` goes through `cleanText` (one line, 200
  characters); `name` must match the agent-name pattern.
- Global agents (`~/.claude/agents`) stay names only: no view asked for more yet.

## Consequences
- A model Claude Code accepts but we do not know (a new alias) shows as no model until the list is updated.
- A long description is cut in the UI; the full text stays in the file.
- The scan reads up to 800 KiB more per project in the worst case; it already runs eight folders at a time.
- Same residual as the local ticket file (ADR 0007): between the `lstat` and the `open`, a file can be swapped
  for a link, and Windows has no `O_NOFOLLOW`. The open can then follow it to another local file (only three
  short, cleaned fields are kept) or to a network share, which makes Windows authenticate to it.
