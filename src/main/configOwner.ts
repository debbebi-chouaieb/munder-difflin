// The config fields that decide what an agent runs and where (ADR 0020 ticket 2).
// The renderer cannot write them through config:update; it asks main through the
// calls below, and main asks a person in a native dialog wherever a script in the
// renderer could otherwise turn on auto mode or point the app at a folder.

import { resolve } from 'node:path';
import { isLocalAbsolute } from './rootGuard';
import { visibleText } from './spawnRecipeGate';

/** Fields config:update never writes. Each has its own main call (or none, for defaultCommand). */
export const MAIN_OWNED_CONFIG_KEYS = [
  'workspaceRoot', // ADR 0001: projects:pickWorkspace
  'approvedSpawns', // ticket 1: main's spawn dialog
  'defaultCommand', // no UI writes it
  'autoMode',
  'orchestratorMaySpawn',
  'registeredRepos',
  'harnessHome',
  'recentHives', // changeHome takes a recent home without asking
  'onboardingComplete' // reopening it would reopen config:completeOnboarding
] as const;

export function withoutMainOwnedConfig<T extends object>(patch: T): Partial<T> {
  const rest: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const key of MAIN_OWNED_CONFIG_KEYS) delete rest[key];
  return rest as Partial<T>;
}

/** One spelling per folder: absolute (resolve drops a trailing separator), case-folded on Windows. */
export function folderKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const p = resolve(path);
  return platform === 'win32' ? p.toLowerCase() : p;
}

/** Folders the native folder dialog returned this session; only main adds to it. */
export interface PickedFolders {
  remember(path: string): void;
  has(path: string): boolean;
}

export function createPickedFolders(platform: NodeJS.Platform = process.platform): PickedFolders {
  const picked = new Set<string>();
  return {
    remember: (path) => { picked.add(folderKey(path, platform)); },
    has: (path) => picked.has(folderKey(path, platform))
  };
}

export interface OwnedConfig {
  onboardingComplete: boolean;
  autoMode: boolean;
  orchestratorMaySpawn: boolean;
  registeredRepos: string[];
  harnessHome: string | null;
  recentHives?: string[];
}

export type ConfirmRequest =
  | { kind: 'autoMode' }
  | { kind: 'orchestratorMaySpawn' }
  | { kind: 'repo'; path: string }
  | { kind: 'home'; path: string };

export interface ConfigOwnerDeps<Config extends OwnedConfig, Owner> {
  read(): Config;
  /** Writes through config:update's own path, so its side effects (hive bootstrap, telemetry) still run. */
  write(patch: Partial<Config>): Config;
  picked: PickedFolders;
  expand(path: string): string;
  /** Creates the home folder; refuses network paths. */
  ensureHome(path: string): { ok: boolean; error?: string };
  /** Ask a person; true only for an explicit yes. */
  confirm(request: ConfirmRequest, owner: Owner | null): Promise<boolean>;
}

export type OwnedResult<Config> = { ok: true; config: Config } | { ok: false; error: string };

export const NOT_CONFIRMED = 'not-confirmed';
export const INVALID_REQUEST = 'invalid-request';

const isPath = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 4096;

/** A repo is a local absolute folder: a network path would make project scans reach out, a relative one is ambiguous. */
function localFolder(path: unknown, expand: (p: string) => string): string | null {
  if (!isPath(path)) return null;
  const p = expand(path.trim());
  return isLocalAbsolute(p) ? resolve(p) : null;
}

export function createConfigOwner<Config extends OwnedConfig, Owner>(deps: ConfigOwnerDeps<Config, Owner>) {
  const same = (a: string, b: string): boolean => folderKey(deps.expand(a)) === folderKey(deps.expand(b));
  const without = (list: string[], path: string): string[] => list.filter((r) => !same(r, path));

  /** A switch that asks before it turns on; turning it off never asks. */
  async function setSwitch(key: 'autoMode' | 'orchestratorMaySpawn', on: unknown, owner: Owner | null): Promise<OwnedResult<Config>> {
    if (typeof on !== 'boolean') return { ok: false, error: INVALID_REQUEST };
    const current = deps.read();
    if (on && current[key] !== true && !(await deps.confirm({ kind: key }, owner))) return { ok: false, error: NOT_CONFIRMED };
    return { ok: true, config: deps.write({ [key]: on } as Partial<Config>) };
  }

  async function addRepo(path: unknown, owner: Owner | null): Promise<OwnedResult<Config>> {
    const p = localFolder(path, deps.expand);
    if (!p) return { ok: false, error: INVALID_REQUEST };
    const repos = deps.read().registeredRepos ?? [];
    const known = repos.some((r) => same(r, p));
    if (!known && !deps.picked.has(p) && !(await deps.confirm({ kind: 'repo', path: p }, owner))) {
      return { ok: false, error: NOT_CONFIRMED };
    }
    return { ok: true, config: deps.write({ registeredRepos: [p, ...without(repos, p)] } as Partial<Config>) };
  }

  /** A hire's "remember this folder": never asks, and ignores a folder that is neither registered nor picked. */
  function promoteRepo(path: unknown): OwnedResult<Config> {
    const p = localFolder(path, deps.expand);
    if (!p) return { ok: false, error: INVALID_REQUEST };
    const current = deps.read();
    const repos = current.registeredRepos ?? [];
    const known = repos.find((r) => same(r, p));
    if (!known && !deps.picked.has(p)) return { ok: true, config: current };
    return { ok: true, config: deps.write({ registeredRepos: [known ?? p, ...without(repos, p)] } as Partial<Config>) };
  }

  function removeRepo(path: unknown): OwnedResult<Config> {
    if (!isPath(path)) return { ok: false, error: INVALID_REQUEST };
    const repos = deps.read().registeredRepos ?? [];
    return { ok: true, config: deps.write({ registeredRepos: without(repos, path) } as Partial<Config>) };
  }

  /** changeHome's check: a picked folder or one of main's recent homes passes; anything else asks. */
  async function homeAllowed(path: string, owner: Owner | null): Promise<boolean> {
    if (deps.picked.has(path)) return true;
    if ((deps.read().recentHives ?? []).some((h) => same(h, path))) return true;
    return deps.confirm({ kind: 'home', path }, owner);
  }

  /** First run only: the wizard's home, repos and auto mode, plus its ordinary fields. */
  function completeOnboarding(payload: unknown): OwnedResult<Config> {
    if (deps.read().onboardingComplete) return { ok: false, error: 'already-onboarded' };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: INVALID_REQUEST };
    const p = payload as Record<string, unknown>;
    const repos = p.registeredRepos;
    if (!isPath(p.harnessHome) || typeof p.autoMode !== 'boolean') return { ok: false, error: INVALID_REQUEST };
    if (!Array.isArray(repos) || repos.length > 100) return { ok: false, error: INVALID_REQUEST };
    const folders = repos.map((r) => localFolder(r, deps.expand));
    if (folders.some((f) => f === null)) return { ok: false, error: INVALID_REQUEST };
    const harnessHome = p.harnessHome.trim();
    const ensured = deps.ensureHome(harnessHome);
    if (!ensured.ok) return { ok: false, error: ensured.error ?? 'could not create the home folder' };
    const rest = withoutMainOwnedConfig(p) as Partial<Config>;
    return {
      ok: true,
      config: deps.write({ ...rest, harnessHome, registeredRepos: folders as string[], autoMode: p.autoMode, onboardingComplete: true } as Partial<Config>)
    };
  }

  return {
    setAutoMode: (on: unknown, owner: Owner | null) => setSwitch('autoMode', on, owner),
    setOrchestratorMaySpawn: (on: unknown, owner: Owner | null) => setSwitch('orchestratorMaySpawn', on, owner),
    addRepo,
    promoteRepo,
    removeRepo,
    homeAllowed,
    completeOnboarding
  };
}

/** The native dialog text for each question. */
export function confirmText(request: ConfirmRequest): { message: string; detail: string; yes: string } {
  switch (request.kind) {
    case 'autoMode':
      return {
        message: 'Turn on auto mode?',
        detail: 'New agents will run tools and edit files without asking you first.',
        yes: 'Turn on'
      };
    case 'orchestratorMaySpawn':
      return {
        message: 'Let the orchestrator hire agents on its own?',
        detail: 'It can then start agents, and spend tokens, without asking you first.',
        yes: 'Allow'
      };
    case 'repo':
      return {
        message: 'Add this folder as a project?',
        detail: `Folder: ${visibleText(request.path)}\n\nAgents can then read and change files in it.`,
        yes: 'Add'
      };
    case 'home':
      return {
        message: 'Use this folder as the app home?',
        detail: `Folder: ${visibleText(request.path)}\n\nThe app keeps its agents, memory and settings here and restarts.`,
        yes: 'Use folder'
      };
  }
}
