// Main's check on every renderer spawn (ADR 0020). A command that matches main's
// recipe for its provider starts silently; anything else starts only after a
// person confirms it in a native dialog, which a script in the renderer cannot
// answer. A confirmed command is remembered, so a restore or restart of the same
// agent does not ask again.

import type { AgentProvider } from '../shared/agentProvider';
import {
  isOnRecipe,
  permissionSkipArgs,
  sameSpawn,
  type ApprovedSpawn,
  type SpawnRecipeConfig
} from '../shared/spawnRecipe';

export const SPAWN_NOT_CONFIRMED = 'spawn-not-confirmed';

export interface SpawnCheck {
  provider: AgentProvider;
  /** The binary, then every arg, as the renderer sent them. */
  argv: string[];
  cwd: string;
}

export interface SpawnConfirmRequest extends SpawnCheck {
  /** Args that turn off the CLI's permission prompts; the dialog warns about them. */
  skipArgs: string[];
}

export interface SpawnRecipeGateDeps<Owner> {
  config(): SpawnRecipeConfig;
  approved(): ApprovedSpawn[];
  approve(spawn: ApprovedSpawn): void;
  /** Ask the person; true only for an explicit "Start". */
  confirm(request: SpawnConfirmRequest, owner: Owner | null): Promise<boolean>;
}

/**
 * Returns the check pty:spawn runs before spawnAgentCore. Identical requests
 * asked at the same time (Restore team) share one dialog.
 */
export function createSpawnRecipeGate<Owner>(deps: SpawnRecipeGateDeps<Owner>) {
  const asking = new Map<string, Promise<boolean>>();
  return async function confirmSpawn(check: SpawnCheck, owner: Owner | null): Promise<boolean> {
    const spawn: ApprovedSpawn = { provider: check.provider, argv: check.argv };
    if (isOnRecipe(deps.config(), check.provider, check.argv)) return true;
    if (deps.approved().some((s) => sameSpawn(s, spawn))) return true;
    const key = JSON.stringify([check.provider, check.argv, check.cwd]);
    const pending = asking.get(key);
    if (pending) return pending;
    const ask = (async () => {
      const yes = await deps.confirm({ ...check, skipArgs: permissionSkipArgs(check.argv.slice(1)) }, owner);
      if (yes) deps.approve(spawn);
      return yes;
    })().finally(() => asking.delete(key));
    asking.set(key, ask);
    return ask;
  };
}

// Control and format characters (newlines, bidi overrides, zero-width) shown as
// escapes, so a crafted arg or folder cannot forge lines or hide text in the dialog.
export const visibleText = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
const quoted = (arg: string): string => visibleText(arg === '' || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg);

/** The dialog text: what runs, where, and a warning when it turns off permission prompts. */
export function spawnConfirmText(request: SpawnConfirmRequest): { message: string; detail: string } {
  const lines = [`Command: ${request.argv.map(quoted).join(' ')}`, `Folder: ${visibleText(request.cwd)}`];
  if (request.skipArgs.length > 0) {
    lines.push('', `Warning: ${request.skipArgs.map(quoted).join(' ')} lets the agent act without asking you first.`);
  }
  lines.push('', 'This is not the command the app builds for this engine. Start it only if you typed or chose it yourself.');
  return { message: 'Start this agent command?', detail: lines.join('\n') };
}

/** Builds the native dialog `confirm` from Electron's dialog API (injected so tests need no Electron). */
export function spawnConfirmDialog<Owner>(
  show: (owner: Owner | null, options: { type: 'warning'; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean; message: string; detail: string }) => Promise<{ response: number }>
) {
  return async (request: SpawnConfirmRequest, owner: Owner | null): Promise<boolean> => {
    const { message, detail } = spawnConfirmText(request);
    const { response } = await show(owner, { type: 'warning', buttons: ['Start', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, message, detail });
    return response === 0;
  };
}
