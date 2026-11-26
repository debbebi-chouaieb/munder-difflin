/**
 * Workspace projects (ADR 0001), main-process side.
 *
 * Reads the workspace root's top-level folders and the per-hive
 * `<harnessHome>/hive/projects.json`, and serves the merged list over IPC. Every
 * project path is built here from the root plus a directory entry name; the
 * renderer never sends a path. The root is set only through the native folder
 * dialog in `projects:pickWorkspace` (the generic config:update strips it).
 */
import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstat, open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mapLimit } from '../shared/mapLimit';
import { AGENT_HEAD_BYTES, MAX_AGENT_FILES, agentDefinitionsFrom, agentNameOfFile, type AgentFileHead } from '../shared/agentDefinition';
import {
  emptyProjectsFile,
  isCandidateFolder,
  isValidProjectId,
  isValidZetahubKey,
  mergeProjects,
  normalizeZetahubKey,
  parseProjectsFile,
  patchStoredProject,
  type ProjectFolder,
  type ProjectResult,
  type ProjectsFile,
  type ProjectsSnapshot,
  type StoredProjectPatch
} from '../shared/project';

/** A CLAUDE.md bigger than this is not read: we only look for one key line. */
const MAX_CLAUDE_MD_BYTES = 512 * 1024;
/** projects.json holds a few flags per folder; anything larger is not ours. */
const MAX_PROJECTS_FILE_BYTES = 256 * 1024;
/** Folders read at the same time during a scan. */
const SCAN_CONCURRENCY = 8;

export interface ProjectServiceDeps {
  workspaceRoot(): string | null;
  setWorkspaceRoot(root: string | null): void;
  /** `<harnessHome>/hive`, or null before a hive exists. */
  hiveRoot(): string | null;
  commit(message: string): void;
  /** Folder holding the user's global agents; see `globalAgentsDirFor`. */
  globalAgentsDir: string;
  push(snapshot: ProjectsSnapshot): void;
  log(message: string): void;
}

type StoredRead = { ok: true; file: ProjectsFile } | { ok: false; error: string };

/**
 * A network path (`\\server\share`, `//server/share`) is refused: reading it makes
 * Windows authenticate to that server with the user's credentials.
 */
export function isLocalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !/^[\\/]{2}/.test(path);
}

/**
 * Where Claude loads user agents from: `$CLAUDE_CONFIG_DIR/agents` when that is a
 * local absolute path (spawned agents keep it, see ptyEnv), else `~/.claude/agents`
 * (ADR 0013).
 */
export function globalAgentsDirFor(env: NodeJS.ProcessEnv, home: string): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir && isLocalAbsolutePath(configDir)) return join(configDir, 'agents');
  return join(home, '.claude', 'agents');
}

export class ProjectService {
  private last: ProjectsSnapshot = { workspaceRoot: null, projects: [], globalAgents: [] };
  private folders: ProjectFolder[] = [];
  private running: Promise<ProjectsSnapshot> | null = null;
  private queued: Promise<ProjectsSnapshot> | null = null;
  private rootCalls = 0;

  constructor(private readonly deps: ProjectServiceDeps) {}

  /** The latest snapshot, after any scan already in progress (e.g. the boot scan). */
  async current(): Promise<ProjectsSnapshot> {
    const pending = this.queued ?? this.running;
    // A failed scan is logged by its caller; the list still answers with the last snapshot.
    if (pending) await pending.catch(() => undefined);
    return this.last;
  }

  /**
   * Scans run one at a time, in order, so a later scan always publishes last.
   * Calls made while one is waiting share it instead of queueing more disk reads.
   */
  rescan(): Promise<ProjectsSnapshot> {
    if (this.queued) return this.queued;
    const previous = this.running ?? Promise.resolve(this.last);
    // A failed scan must not stop the ones queued after it.
    const next: Promise<ProjectsSnapshot> = previous.catch(() => this.last).then(() => {
      this.queued = null;
      this.running = next;
      return this.scanAndPublish();
    }).finally(() => {
      if (this.running === next) this.running = null;
    });
    this.queued = next;
    return next;
  }

  async setWorkspaceRoot(root: string | null): Promise<ProjectResult> {
    const call = ++this.rootCalls;
    if (root !== null && (!isLocalAbsolutePath(root) || !(await isDirectory(root)))) {
      return { ok: false, error: 'pick a local folder' };
    }
    // A newer pick or clear arrived while this one checked the folder: it wins.
    if (call !== this.rootCalls) return { ok: false, error: 'superseded' };
    try {
      this.deps.setWorkspaceRoot(root);
    } catch (e) {
      return { ok: false, error: `could not save the workspace: ${errText(e)}` };
    }
    return { ok: true, snapshot: await this.rescan() };
  }

  /**
   * Read, patch and write projects.json with no await in between, so two patches
   * cannot interleave on the main thread. Re-merges the folders of the last scan
   * instead of reading the workspace again.
   */
  patch(id: unknown, patch: StoredProjectPatch): ProjectResult {
    if (typeof id !== 'string' || !isValidProjectId(id)) return { ok: false, error: 'invalid project id' };
    if (!this.last.projects.some((p) => p.id === id)) return { ok: false, error: 'unknown project' };
    if (typeof patch.zetahubKey === 'string' && !isValidZetahubKey(patch.zetahubKey)) {
      return { ok: false, error: 'invalid ZetaHub key' };
    }
    const hive = this.deps.hiveRoot();
    if (!hive || !existsSync(hive)) return { ok: false, error: 'no hive yet' };
    const stored = this.readStored();
    if (!stored.ok) return { ok: false, error: stored.error };
    const next = patchStoredProject(stored.file, id, patch);
    try {
      atomicWriteJson(join(hive, 'projects.json'), next);
    } catch (e) {
      return { ok: false, error: `could not save projects.json: ${errText(e)}` };
    }
    try {
      this.deps.commit(`hive: project ${id}`);
    } catch (e) {
      // The file is saved; a failed commit only loses its history entry.
      this.deps.log(`[projects] commit failed: ${errText(e)}`);
    }
    // Drop a stale read error: the file was just read and written successfully.
    const { error: _cleared, ...rest } = this.last;
    return { ok: true, snapshot: this.publish({ ...rest, projects: mergeProjects(this.folders, next) }) };
  }

  private async scanAndPublish(): Promise<ProjectsSnapshot> {
    const globalAgents = agentDefinitionsFrom(await agentHeads(this.deps.globalAgentsDir));
    const root = this.deps.workspaceRoot();
    if (!root) return this.publishScan([], { workspaceRoot: null, projects: [], globalAgents });
    if (!isLocalAbsolutePath(root)) {
      return this.publishScan([], { workspaceRoot: root, projects: [], globalAgents, error: 'workspace is not a local folder' });
    }
    const read = await readWorkspace(root);
    if (!read.ok) return this.publishScan([], { workspaceRoot: root, projects: [], globalAgents, error: read.error });
    const stored = this.readStored();
    return this.publishScan(read.folders, {
      workspaceRoot: root,
      projects: mergeProjects(read.folders, stored.ok ? stored.file : emptyProjectsFile()),
      globalAgents,
      ...(stored.ok ? {} : { error: stored.error })
    });
  }

  /**
   * A missing file is an empty state. A file that is not valid JSON is moved
   * aside (kept for the user) and replaced on the next write. A file that cannot
   * be read right now (locked, too large) blocks writes, so a toggle never wipes
   * the other projects' state.
   */
  private readStored(): StoredRead {
    const hive = this.deps.hiveRoot();
    if (!hive) return { ok: true, file: emptyProjectsFile() };
    const path = join(hive, 'projects.json');
    let text: string;
    try {
      if (statSync(path).size > MAX_PROJECTS_FILE_BYTES) return { ok: false, error: 'projects.json is too large' };
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file: emptyProjectsFile() };
      this.deps.log(`[projects] cannot read projects.json: ${errText(e)}`);
      return { ok: false, error: 'projects.json cannot be read' };
    }
    try {
      return { ok: true, file: parseProjectsFile(JSON.parse(text)) };
    } catch {
      const aside = `${path}.bad-${Date.now()}`;
      try {
        renameSync(path, aside);
        this.deps.log(`[projects] projects.json was not valid JSON; moved to ${aside}`);
        return { ok: true, file: emptyProjectsFile() };
      } catch (e) {
        this.deps.log(`[projects] could not move bad projects.json aside: ${errText(e)}`);
        return { ok: false, error: 'projects.json is not valid JSON' };
      }
    }
  }

  private publishScan(folders: ProjectFolder[], snapshot: ProjectsSnapshot): ProjectsSnapshot {
    this.folders = folders;
    return this.publish(snapshot);
  }

  private publish(snapshot: ProjectsSnapshot): ProjectsSnapshot {
    this.last = snapshot;
    try {
      this.deps.push(snapshot);
    } catch (e) {
      // The change is saved; a window that is reloading pulls projects:list instead.
      this.deps.log(`[projects] push failed: ${errText(e)}`);
    }
    return snapshot;
  }
}

/** Reads each top-level entry; only candidate folders get the extra reads. */
export async function readWorkspace(
  root: string
): Promise<{ ok: true; folders: ProjectFolder[] } | { ok: false; error: string }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `cannot read workspace: ${(e as NodeJS.ErrnoException).code ?? errText(e)}` };
  }
  const folders = await mapLimit(entries, SCAN_CONCURRENCY, async (entry): Promise<ProjectFolder> => {
    const path = join(root, entry.name);
    const base: ProjectFolder = {
      name: entry.name,
      path,
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
      isGitRepo: false,
      claudeMd: null,
      agentFiles: []
    };
    if (!isCandidateFolder(base.name, base.isDirectory, base.isSymlink)) return base;
    if (!(await exists(join(path, '.git')))) return base;
    return {
      ...base,
      isGitRepo: true,
      claudeMd: (await readSmallText(join(path, 'CLAUDE.md'))) ?? (await readSmallText(join(path, '.claude', 'CLAUDE.md'))),
      agentFiles: await agentHeads(join(path, '.claude', 'agents'))
    };
  });
  return { ok: true, folders };
}

/** A plain file (not a link) under the size cap, or null. */
async function readSmallText(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_CLAUDE_MD_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The first AGENT_HEAD_BYTES of each agent file in a real `.claude/agents` folder,
 * at most MAX_AGENT_FILES of them (ADR 0009). Files with no valid agent name are
 * not opened; an unreadable file keeps its name with a null head.
 */
async function agentHeads(dir: string): Promise<AgentFileHead[]> {
  const files = (await listFiles(dir)).filter((f) => agentNameOfFile(f) !== null).sort().slice(0, MAX_AGENT_FILES);
  return mapLimit(files, SCAN_CONCURRENCY, async (file) => ({ file, head: await readHead(join(dir, file), AGENT_HEAD_BYTES) }));
}

/** Up to `maxBytes` of a plain file (not a link) as UTF-8, or null. */
async function readHead(path: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    if (!(await lstat(path)).isFile()) return null;
    handle = await open(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Plain file names in a real (not linked) directory; empty when absent. */
async function listFiles(dir: string): Promise<string[]> {
  try {
    if (!(await lstat(dir)).isDirectory()) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Write to a temp file, then rename. The temp file never survives a failure,
 *  because the next hive commit stages everything in the folder. */
function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(tmp, path);
    } catch (e) {
      // Windows: antivirus or the indexer can hold the target for a moment.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      renameSync(tmp, path);
    }
  } finally {
    // Never let cleanup replace the write's own error.
    try { rmSync(tmp, { force: true }); } catch { /* reported by the next write */ }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** IPC surface. Push channel: `projects:changed` with the full snapshot. */
export function registerProjectsIpc(service: ProjectService): void {
  ipcMain.handle('projects:list', () => service.current());
  ipcMain.handle('projects:rescan', () => service.rescan());
  ipcMain.handle('projects:pickWorkspace', async (evt): Promise<ProjectResult> => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return { ok: false, error: 'no window' };
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Pick the workspace folder'
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'cancelled' };
    return service.setWorkspaceRoot(res.filePaths[0]);
  });
  ipcMain.handle('projects:clearWorkspace', () => service.setWorkspaceRoot(null));
  ipcMain.handle('projects:setEnabled', (_evt, id: unknown, enabled: unknown): ProjectResult =>
    typeof enabled === 'boolean' ? service.patch(id, { enabled }) : { ok: false, error: 'invalid value' });
  ipcMain.handle('projects:setParallel', (_evt, id: unknown, parallel: unknown): ProjectResult =>
    typeof parallel === 'boolean' ? service.patch(id, { parallel }) : { ok: false, error: 'invalid value' });
  // null returns the room's ZetaHub section to auto (shown when the project has a key).
  ipcMain.handle('projects:setShowZetahub', (_evt, id: unknown, show: unknown): ProjectResult =>
    typeof show === 'boolean' || show === null ? service.patch(id, { showZetahub: show }) : { ok: false, error: 'invalid value' });
  ipcMain.handle('projects:setZetahubKey', (_evt, id: unknown, key: unknown): ProjectResult => {
    const normalized = normalizeZetahubKey(key);
    return normalized.ok ? service.patch(id, { zetahubKey: normalized.key }) : { ok: false, error: 'invalid ZetaHub key' };
  });
}

/** Sends to the live window; with no window the renderer pulls projects:list later. */
export function projectsPusher(getWebContents: () => WebContents | null): (s: ProjectsSnapshot) => void {
  return (snapshot) => {
    getWebContents()?.send('projects:changed', snapshot);
  };
}
