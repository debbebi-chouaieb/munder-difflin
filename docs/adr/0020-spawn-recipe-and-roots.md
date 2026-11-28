# 0020. Main checks every agent spawn against its own recipe; only main-set folders are roots

- **Status**: Accepted
- **Date**: 2026-11-28
- **Scope**: `pty:spawn` and `spawnAgentCore` in `src/main/index.ts`, `knownRoots`, `config:update`,
  `buildSpawnCommand` (moves to `src/shared`), the hire dialog's folder and repo list

## Context
ADR 0019 took room leads off `pty:spawn`. Every other agent still runs the command, args and folder the
renderer sends (pty:spawn audit, 2026-11-28). The renderer is sandboxed with context isolation, but the
preload exposes `spawnPty`, so a script injected into it (a rendered ticket, markdown) can:
- run any binary with any args, or add `--dangerously-skip-permissions` with auto mode off (findings 2, 6);
- spawn in any local folder, which then becomes an fs/git root: live pty folders and registry folders are both
  in `knownRoots` (finding 4).
The recipe main could check against is also renderer-owned: `config:update` writes `defaultCommand`, `autoMode`,
`registeredRepos` and `harnessHome`. Only `workspaceRoot` is main-owned (ADR 0001). The hire dialog has a free
command field and accepts a typed folder, and people use both.

## Options
### Command and args
- **A. Native confirm on anything off main's recipe.** Main computes the recipe from the provider preset, the
  model and its own config. A matching spawn starts silently; anything else asks in a native dialog, which the
  renderer cannot answer. The free command field keeps working.
- **B. Main builds every command.** The renderer sends provider, model and flags of intent only. Strongest; moves
  the hire, restore, restart and revive builders to main and drops the free command field.
- **C. Allowlist.** Preset binaries and filtered flags only. No prompts; breaks custom commands, and flag lists
  drift with the CLIs.

### Folders and roots
- **A. Main-set roots.** An agent starts in the workspace, a registered repo, the harness home, a worktree main
  made, or a folder picked in the folder dialog. A typed folder asks once in a native dialog. Spawns no longer
  add roots by themselves.
- **B. Confirm every new folder.** Simpler; the root list still grows from spawns, behind a prompt.
- **C. Dialog only.** Tightest; typed and pasted paths stop working.

## Decision
**Command A, folders A.**

Recipe (command A):
- `buildSpawnCommand` moves to `src/shared/spawnRecipe.ts` unchanged, so renderer and main build the same text.
- `spawnAgentCore` checks a renderer spawn (`pty:spawn` only; main's own spawns are trusted) before anything runs:
  `[command, ...args]` must equal the tokenized recipe for its provider, with or without the provider's model flag
  and one value, and with the provider's auto flag only when `autoMode` is on. Flags main adds later (resume,
  agent, hive) are not in the request and not part of the check.
- Off-recipe spawns show a native dialog in the spawning window: the binary, every arg, the folder, and a warning
  when an arg is a known permission-skip flag. "Start" runs it; "Cancel" returns `spawn-not-confirmed`.
- A confirmed command is remembered in main's config as `approvedSpawns` (provider plus the exact argv), so a
  restore or restart of that agent does not ask again. A Settings list shows and removes entries.

Main-owned config (both decisions depend on it):
- `config:update` drops `defaultCommand`, `autoMode`, `registeredRepos` and `harnessHome`, like `workspaceRoot`.
- `config:setDefaultCommand` and turning `autoMode` on ask in a native dialog; turning `autoMode` off does not.
- Registered repos are added only through the native folder dialog (`repos:add`); `repos:remove` needs no
  dialog. `harnessHome` is set only through `config:changeHome` and onboarding, both behind the folder dialog.

Folders (folders A):
- A spawn folder must be inside a main-set root (workspace, registered repo, harness home, a worktree main made)
  or be a folder the folder dialog returned this session. Otherwise a native dialog asks once; a "yes" adds the
  folder to `registeredRepos`, so it is an ordinary root from then on.
- `knownRoots` drops live pty folders. Registry folders count only when main checked them at spawn: the registry
  record gains `cwdChecked: true`, and older records without it are not roots until their agent spawns again.

## Consequences
- An injected script can still start a preset CLI with a model flag in a main-set folder: the same as a normal
  hire. Anything beyond that needs a person at a native dialog.
- People with a custom command or a typed folder see one confirm per command or folder, then never again.
- Turning on auto mode and adding a registered repo now go through native dialogs.
- Stopped agents from before this change lose their Files and Git tabs until they run again (no `cwdChecked`).
- Built in three tickets: (1) shared recipe, check and confirm, `approvedSpawns`; (2) main-owned config fields;
  (3) folders and roots. Ticket 3 needs ticket 2, because `registeredRepos` is the store for confirmed folders.
- Git hooks on `worktree add` and `switch` and filter drivers stay a separate item.
