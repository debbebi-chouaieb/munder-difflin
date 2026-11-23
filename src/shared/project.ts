/**
 * Workspace projects (ADR 0001): each non-hidden, top-level git folder of the
 * workspace root is one project, one office room and one sidebar checkbox.
 *
 * Pure: no fs, no electron. The main process collects `ProjectFolder` facts and
 * the stored per-hive state; everything that decides what a project IS lives
 * here so it can be unit tested and shared with the renderer.
 */

/** Per-project state the user controls, persisted in `<hive>/projects.json`. */
export interface StoredProject {
  enabled: boolean;
  parallel: boolean;
  /** User-set ZetaHub key; overrides the one read from the project's CLAUDE.md. */
  zetahubKey?: string;
  /** The project lead agent (ADR 0003), set once it is spawned. */
  leadAgentId?: string;
  /**
   * The folder the user trusted for room leads (ADR 0005): folder-trust pre-accept
   * and auto mode. Bound to the path, so a project id that shifts to another
   * folder (slug collision, folder removed) does not carry trust with it.
   */
  trustedPath?: string;
  /**
   * The repo's root commit hashes when trust was given (ADR 0007), sorted and
   * joined by ",". A re-clone of another repo at `trustedPath` does not match.
   */
  trustedRoot?: string;
  /** Room ZetaHub section on or off (ADR 0005); absent: shown when the project has a key. */
  showZetahub?: boolean;
}

/** A change to one project. `zetahubKey: null` removes the user-set key; `showZetahub: null` returns to auto. */
export type StoredProjectPatch = Partial<Omit<StoredProject, 'zetahubKey' | 'trustedPath' | 'trustedRoot' | 'showZetahub'>> & {
  zetahubKey?: string | null;
  showZetahub?: boolean | null;
  /** Null removes trust. */
  trustedPath?: string | null;
  trustedRoot?: string | null;
};

export interface ProjectsFile {
  version: 1;
  /** Null-prototype map: an id such as `constructor` never reads Object.prototype. */
  projects: Record<string, StoredProject>;
}

/** What the main process found on disk for one top-level entry. */
export interface ProjectFolder {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  isGitRepo: boolean;
  /** Contents of `CLAUDE.md` or `.claude/CLAUDE.md`, or null when absent. */
  claudeMd: string | null;
  /** File names found in `.claude/agents/`. */
  agentFiles: string[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  parallel: boolean;
  zetahubKey: string | null;
  /** Where `zetahubKey` came from, so the UI can tell a guess from a setting. */
  zetahubKeySource: 'user' | 'claude-md' | null;
  hasClaudeMd: boolean;
  /** The project's own agents (`.claude/agents/<name>.md`): desks started on demand. */
  agents: string[];
  leadAgentId: string | null;
  /**
   * Trust was given for this folder and bound to a repo (ADR 0007). Main still
   * checks that the folder's root commit matches `trustedRoot` before using it.
   */
  trusted: boolean;
  trustedRoot: string | null;
  /** Relative path from the "Local open work:" line of CLAUDE.md (ADR 0005), or null. */
  localWorkPath: string | null;
  /** The user's choice for the room ZetaHub section; null: auto (see `zetahubShown`). */
  showZetahub: boolean | null;
}

export interface ProjectsSnapshot {
  workspaceRoot: string | null;
  projects: Project[];
  /** Global agents (`~/.claude/agents/<name>.md`): the tech-leads room. */
  globalAgents: string[];
  /** Set when the workspace root or projects.json could not be read. */
  error?: string;
}

export type ProjectResult = { ok: true; snapshot: ProjectsSnapshot } | { ok: false; error: string };

const ZETAHUB_KEY = /^[A-Z][A-Z0-9]{0,9}(?:-[A-Z0-9]{1,10})?$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Same shape `projectIdFor` produces; also keeps `__proto__` out of the map. */
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_KEY_INPUT = 64;

export function emptyProjectsFile(): ProjectsFile {
  return { version: 1, projects: Object.create(null) };
}

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID.test(id);
}

export function isValidZetahubKey(key: string): boolean {
  return ZETAHUB_KEY.test(key);
}

/** A top-level entry worth checking for `.git`: a real, non-hidden directory. */
export function isCandidateFolder(name: string, isDirectory: boolean, isSymlink: boolean): boolean {
  return isDirectory && !isSymlink && !name.startsWith('.') && !/[\\/]/.test(name);
}

/** Hidden folders (`.claude`, `.idea`) are tooling; plain folders cannot get worktrees. */
export function isProjectFolder(folder: ProjectFolder): boolean {
  return folder.isGitRepo && isCandidateFolder(folder.name, folder.isDirectory, folder.isSymlink);
}

/** Stable id from the folder name: lower case, [a-z0-9-], never empty. */
export function projectIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/**
 * Reads a line such as "ZetaHub project key: `MDM`" from a project's CLAUDE.md.
 * The value must be back-ticked or already upper case, so prose such as
 * "ZetaHub project key: none yet" is not read as a key.
 */
export function parseZetahubKey(claudeMd: string | null): string | null {
  if (!claudeMd) return null;
  const match = /[Zz]eta[Hh]ub [Pp]roject [Kk]ey\s*[:=]\s*(?:`([A-Za-z][A-Za-z0-9-]{0,20})`|([A-Z][A-Z0-9-]{0,20})(?![A-Za-z0-9]))/.exec(claudeMd);
  if (!match) return null;
  const key = (match[1] ?? match[2]).toUpperCase().replace(/-+$/, '');
  return isValidZetahubKey(key) ? key : null;
}

const MAX_TRUSTED_PATH = 1024;
/** SHA-1 or SHA-256 commit ids, a few roots at most (a repo with merged histories). */
const TRUSTED_ROOT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?:,[0-9a-f]{40}(?:[0-9a-f]{24})?){0,15}$/;

export function isValidTrustedRoot(value: unknown): value is string {
  return typeof value === 'string' && TRUSTED_ROOT.test(value);
}

/** The stored form of `git rev-list --max-parents=0 HEAD` output, or null when it names no valid root. */
export function trustedRootFrom(revListOutput: string): string | null {
  const roots = [...new Set(revListOutput.split(/\s+/).map((line) => line.trim()).filter(Boolean))].sort();
  const joined = roots.join(',');
  return roots.length > 0 && isValidTrustedRoot(joined) ? joined : null;
}

/** Path equality that ignores slash direction, a trailing slash and case (Windows folders). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The relative path in a line such as "Local open work: `docs/in-progress.md`".
 * Back-ticks are required, so prose never reads as a path.
 */
export function parseLocalWorkPath(claudeMd: string | null): string | null {
  if (!claudeMd) return null;
  const match = /[Ll]ocal open work\s*[:=]\s*`([^`\r\n]{1,200})`/.exec(claudeMd);
  return match ? match[1].trim() || null : null;
}

/** User input for a key: empty clears it, anything else must be a valid key. */
export function normalizeZetahubKey(input: unknown): { ok: true; key: string | null } | { ok: false } {
  if (input === null) return { ok: true, key: null };
  if (typeof input !== 'string' || input.length > MAX_KEY_INPUT) return { ok: false };
  const key = input.trim().toUpperCase();
  if (key === '') return { ok: true, key: null };
  return isValidZetahubKey(key) ? { ok: true, key } : { ok: false };
}

/** Agent names from `<name>.md` definition files, sorted, invalid names dropped. */
export function agentNamesFrom(files: string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (AGENT_NAME.test(name)) names.add(name);
  }
  return [...names].sort(byCodePoint);
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function storedFor(file: ProjectsFile, id: string): StoredProject | undefined {
  return Object.prototype.hasOwnProperty.call(file.projects, id) ? file.projects[id] : undefined;
}

/**
 * Joins what is on disk with what the user stored. A new folder starts disabled
 * (ADR 0003: each enabled project runs a lead agent). Stored entries whose folder
 * is gone are not listed and stay in the file unchanged, so the folder gets its
 * state back if it returns. Folders that slug to the same id get a numeric
 * suffix, in code-point order of their names.
 */
export function mergeProjects(folders: ProjectFolder[], stored: ProjectsFile): Project[] {
  const used = new Set<string>();
  return folders
    .filter(isProjectFolder)
    .sort((a, b) => byCodePoint(a.name, b.name))
    .map((folder) => {
      const base = projectIdFor(folder.name);
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      const saved = storedFor(stored, id);
      const userKey = saved?.zetahubKey && isValidZetahubKey(saved.zetahubKey) ? saved.zetahubKey : null;
      const fileKey = parseZetahubKey(folder.claudeMd);
      return {
        id,
        name: folder.name,
        path: folder.path,
        enabled: saved?.enabled === true,
        parallel: saved?.parallel === true,
        zetahubKey: userKey ?? fileKey,
        zetahubKeySource: userKey ? 'user' : fileKey ? 'claude-md' : null,
        hasClaudeMd: folder.claudeMd !== null,
        agents: agentNamesFrom(folder.agentFiles),
        leadAgentId: saved?.leadAgentId ?? null,
        // A record saved before ADR 0007 has no root: ask once more.
        trusted: !!saved?.trustedPath && !!saved.trustedRoot && samePath(saved.trustedPath, folder.path),
        trustedRoot: saved?.trustedRoot ?? null,
        localWorkPath: parseLocalWorkPath(folder.claudeMd),
        showZetahub: typeof saved?.showZetahub === 'boolean' ? saved.showZetahub : null
      };
    });
}

/**
 * Whether a project's room shows the ZetaHub section: the user's choice, else
 * only when the project has a ZetaHub key (a local-only project shows no ZetaHub).
 */
export function zetahubShown(project: Pick<Project, 'showZetahub' | 'zetahubKey'>): boolean {
  return project.showZetahub ?? project.zetahubKey !== null;
}

/** Tolerant read of parsed `projects.json`: malformed entries are dropped. */
export function parseProjectsFile(raw: unknown): ProjectsFile {
  const file = emptyProjectsFile();
  if (!raw || typeof raw !== 'object') return file;
  const source = (raw as { projects?: unknown }).projects;
  if (!source || typeof source !== 'object') return file;
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || !isValidProjectId(id)) continue;
    const v = value as Record<string, unknown>;
    file.projects[id] = {
      enabled: v.enabled === true,
      parallel: v.parallel === true,
      ...(typeof v.zetahubKey === 'string' && isValidZetahubKey(v.zetahubKey) ? { zetahubKey: v.zetahubKey } : {}),
      ...(typeof v.leadAgentId === 'string' && v.leadAgentId ? { leadAgentId: v.leadAgentId } : {}),
      ...(typeof v.trustedPath === 'string' && v.trustedPath && v.trustedPath.length <= MAX_TRUSTED_PATH ? { trustedPath: v.trustedPath } : {}),
      ...(isValidTrustedRoot(v.trustedRoot) ? { trustedRoot: v.trustedRoot } : {}),
      ...(typeof v.showZetahub === 'boolean' ? { showZetahub: v.showZetahub } : {})
    };
  }
  return file;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The project an agent works in, from its working directory: the project whose
 * folder is the cwd or contains it. Case-insensitive, because the workspace is a
 * Windows folder and drive letters come back in either case. Agents in a git
 * worktree under the hive home do not match; Phase 4 records their project.
 */
export function projectIdForCwd(cwd: string, projects: Pick<Project, 'id' | 'path'>[]): string | null {
  if (!cwd) return null;
  const target = normalizePath(cwd);
  for (const project of projects) {
    const root = normalizePath(project.path);
    if (target === root || target.startsWith(`${root}/`)) return project.id;
  }
  return null;
}

/**
 * The workspace root is main-owned: it is set only through the validated folder
 * dialog (projects:pickWorkspace), never through a generic config patch.
 */
export function withoutWorkspaceRoot<T extends { workspaceRoot?: unknown }>(patch: T): Omit<T, 'workspaceRoot'> {
  const { workspaceRoot: _mainOwned, ...rest } = patch;
  return rest;
}

/** Returns a new file with one project's stored state patched. */
export function patchStoredProject(file: ProjectsFile, id: string, patch: StoredProjectPatch): ProjectsFile {
  const next: StoredProject = { ...(storedFor(file, id) ?? { enabled: false, parallel: false }) };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.parallel === 'boolean') next.parallel = patch.parallel;
  if (patch.zetahubKey === null) delete next.zetahubKey;
  else if (typeof patch.zetahubKey === 'string') next.zetahubKey = patch.zetahubKey;
  if (typeof patch.leadAgentId === 'string') next.leadAgentId = patch.leadAgentId;
  if (patch.trustedPath === null) delete next.trustedPath;
  else if (typeof patch.trustedPath === 'string' && patch.trustedPath && patch.trustedPath.length <= MAX_TRUSTED_PATH) {
    next.trustedPath = patch.trustedPath;
  }
  if (patch.trustedRoot === null) delete next.trustedRoot;
  else if (isValidTrustedRoot(patch.trustedRoot)) next.trustedRoot = patch.trustedRoot;
  if (patch.showZetahub === null) delete next.showZetahub;
  else if (typeof patch.showZetahub === 'boolean') next.showZetahub = patch.showZetahub;
  const projects: Record<string, StoredProject> = Object.assign(Object.create(null), file.projects);
  projects[id] = next;
  return { version: 1, projects };
}
