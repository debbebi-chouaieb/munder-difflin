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
}

/** A change to one project. `zetahubKey: null` removes the user-set key. */
export type StoredProjectPatch = Partial<Omit<StoredProject, 'zetahubKey'>> & { zetahubKey?: string | null };

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
        leadAgentId: saved?.leadAgentId ?? null
      };
    });
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
      ...(typeof v.leadAgentId === 'string' && v.leadAgentId ? { leadAgentId: v.leadAgentId } : {})
    };
  }
  return file;
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
  const projects: Record<string, StoredProject> = Object.assign(Object.create(null), file.projects);
  projects[id] = next;
  return { version: 1, projects };
}
