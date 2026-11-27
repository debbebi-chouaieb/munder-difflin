// Main-side plumbing for project rooms (ADR 0005, ADR 0007): Claude's own folder
// trust, the project folder check, and which window owns each lead's card.
// Kept out of index.ts so it can be unit tested with a temp home folder.

import { join } from 'node:path';
import { lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { samePath, trustedRootFrom, type Project, type StoredProjectPatch } from '../shared/project';
import { leadAgentIdFor } from '../shared/roomLead';
import { claudeTrustCovers, claudeTrustsExactly, projectMcpConfigNear, trustPromptExpected } from '../shared/claudeTrust';
import { resolveAllowedRoot } from './rootGuard';
import { createLeadLock, type LeadLock } from './leadLock';

export const CLAUDE_CONFIG_MAX_BYTES = 32 * 1024 * 1024;

export interface RoomWiringDeps {
  homedir: () => string;
  now?: () => number;
  caseInsensitivePaths: boolean;
  workspaceRoot: () => string | null | undefined;
  liveWebContents: () => WebContents | null;
  /** Raw `git rev-list --max-parents=0 HEAD` output in `cwd`, or null when git failed. */
  rootCommitsOutput: (cwd: string) => Promise<string | null>;
  /** Saves stored project fields; false when the write failed. */
  patchProject: (projectId: string, patch: StoredProjectPatch) => boolean;
  log: (line: string) => void;
}

/**
 * `none`: never trusted; `stale`: trusted, but the folder now holds another repo
 * (or one with no commit); `unknown`: git could not be asked, so nothing is decided.
 */
export type TrustState = 'trusted' | 'stale' | 'unknown' | 'none';

export interface RoomWiring {
  /** Parsed ~/.claude.json, or null when it is missing, too big or unreadable (then Claude will ask). */
  readClaudeConfig: () => Promise<unknown>;
  /** Claude Code already trusts `cwd` or a parent (~/.claude.json), so it shows no folder-trust dialog there. */
  claudeTrustsFolder: (cwd: string) => Promise<boolean>;
  /** Whether an untrusted lead in `cwd` may meet a startup prompt that Enter would answer "yes". */
  leadMayMeetTrustPrompt: (cwd: string) => Promise<boolean>;
  /** The project folder's real path when it is a plain folder inside the workspace, else null. */
  resolveProjectCwd: (projectPath: string) => Promise<string | null>;
  /**
   * The folder a lead may run trusted in: its project is trusted and `cwd` is
   * that project's own folder, a plain folder in the workspace. Anything else
   * (a replay with another cwd, a moved or linked folder, a late project list
   * passed as null) gives null: run untrusted.
   */
  trustedLeadFolder: (leadId: string, cwd: string, projects: Project[] | null) => Promise<string | null>;
  /** Whether `cwd` still resolves to `folder` right before a trusted spawn. */
  stillLeadFolder: (cwd: string, folder: string) => Promise<boolean>;
  /** The stored form of the repo's root commits in `cwd`, or null (no git, no commit). */
  repoRoot: (cwd: string) => Promise<string | null>;
  /** Whether stored trust still holds for the repo now in `cwd` (ADR 0007). */
  trustState: (project: Project, cwd: string) => Promise<TrustState>;
  /**
   * Drops the project's trust and Claude's own folder trust for its folder, so
   * the next lead asks again. False when any part could not be saved.
   */
  revokeTrust: (project: Project, cwd: string | null) => Promise<boolean>;
  /**
   * The person's "Forget trust" (ADR 0012): drops Claude's folder trust first and
   * the stored trust only once that worked, so a failure leaves the project
   * trusted and the person can retry. False when any part could not be saved.
   */
  forgetTrust: (project: Project, cwd: string | null) => Promise<boolean>;
  /** Notes that the person used this lead's terminal now; the room cap stops the least recently used. */
  touchLead: (agentId: string) => void;
  /** Epoch ms of the last use, or 0 when never seen since the app started. */
  leadLastUsed: (agentId: string) => number;
  /**
   * A window put the lead's terminal on screen or took it off. Both count as use,
   * so an idle clock starts when the terminal leaves the screen. A closed window
   * shows nothing any more.
   */
  setLeadShown: (agentId: string, window: WebContents, shown: boolean) => void;
  /** Whether any window shows this lead's terminal now. */
  isLeadShown: (agentId: string) => boolean;
  /** Records the window that opened a lead, so its archive goes where its card was made. */
  ownLead: (agentId: string, owner: WebContents) => void;
  leadWindow: (agentId: string) => WebContents | null;
  /** Tells the lead's window to archive its card; the renderer ignores an unknown id. */
  archiveLeadCard: (agentId: string) => void;
  announceLead: (id: string, name: string, cwd: string, target: WebContents | null) => void;
  /** Who may open, spawn or forget a lead right now (ADR 0017). */
  leadLock: LeadLock;
}

export function createRoomWiring(deps: RoomWiringDeps): RoomWiring {
  const leadOwners = new Map<string, WebContents>();
  // One entry per lead id that was ever used, so bounded by the project count.
  const leadUsedAt = new Map<string, number>();
  // Lead id to the ids of the windows showing its terminal; only live leads get in (see index.ts).
  const shownIn = new Map<string, Set<number>>();
  const watchedWindows = new Set<number>();
  const now = deps.now ?? Date.now;

  const readClaudeConfig = async (): Promise<unknown> => {
    const file = join(deps.homedir(), '.claude.json');
    try {
      if ((await stat(file)).size > CLAUDE_CONFIG_MAX_BYTES) {
        deps.log('[room] ~/.claude.json too big to check folder trust');
        return null;
      }
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') deps.log(`[room] could not read ~/.claude.json: ${errText(e)}`);
      return null;
    }
  };

  const resolveProjectCwd = async (projectPath: string): Promise<string | null> => {
    const root = deps.workspaceRoot();
    if (!root) return null;
    try {
      if ((await lstat(projectPath)).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return resolveAllowedRoot(projectPath, [root]);
  };

  const repoRoot = async (cwd: string): Promise<string | null> => {
    const out = await deps.rootCommitsOutput(cwd);
    return out === null ? null : trustedRootFrom(out);
  };

  /** Claude's key for a folder in the form used to compare keys: forward slashes, no trailing one. */
  const folderKey = (folder: string): string => {
    const key = folder.replace(/\\/g, '/').replace(/\/+$/, '');
    return deps.caseInsensitivePaths ? key.toLowerCase() : key;
  };

  /**
   * Drops `hasTrustDialogAccepted` from every key that names `folder` (any slash
   * or, on Windows, letter case); parents were never written by the app. The
   * file is replaced by a rename, so a running claude never reads it half written.
   */
  const forgetClaudeFolderTrust = async (folder: string): Promise<boolean> => {
    const file = join(deps.homedir(), '.claude.json');
    try {
      if ((await stat(file)).size > CLAUDE_CONFIG_MAX_BYTES) {
        deps.log('[room] ~/.claude.json too big to remove folder trust');
        return false;
      }
      const config: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        deps.log('[room] ~/.claude.json is not an object; folder trust not removed');
        return false;
      }
      const projects = (config as { projects?: unknown }).projects;
      if (!projects || typeof projects !== 'object') return true;
      const wanted = folderKey(folder);
      let changed = false;
      for (const [key, entry] of Object.entries(projects as Record<string, unknown>)) {
        if (folderKey(key) === wanted && entry && typeof entry === 'object' && 'hasTrustDialogAccepted' in entry) {
          delete (entry as Record<string, unknown>).hasTrustDialogAccepted;
          changed = true;
        }
      }
      if (!changed) return true;
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(config, null, 2), 'utf8');
      try {
        await rename(temp, file);
      } catch (e) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw e;
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      deps.log(`[room] could not remove folder trust from ~/.claude.json: ${errText(e)}`);
      return false;
    }
  };

  /** Pre-accept wrote the folder the lead ran in, the resolved one; the stored spelling goes too. */
  const forgetClaudeTrustOf = async (project: Project, cwd: string | null): Promise<boolean> => {
    const folders = cwd && !samePath(cwd, project.path) ? [project.path, cwd] : [project.path];
    let forgot = true;
    for (const folder of folders) forgot = (await forgetClaudeFolderTrust(folder)) && forgot;
    return forgot;
  };

  const dropStoredTrust = (project: Project): boolean => {
    const saved = deps.patchProject(project.id, { trustedPath: null, trustedRoot: null });
    if (!saved) deps.log(`[room] could not drop trust for ${project.id}`);
    return saved;
  };

  const leadWindow = (agentId: string): WebContents | null => {
    const owner = leadOwners.get(agentId);
    return owner && !owner.isDestroyed() ? owner : deps.liveWebContents();
  };

  return {
    leadLock: createLeadLock(),
    readClaudeConfig,

    async claudeTrustsFolder(cwd) {
      return claudeTrustCovers(await readClaudeConfig(), cwd, deps.caseInsensitivePaths);
    },

    async leadMayMeetTrustPrompt(cwd) {
      const exact = claudeTrustsExactly(await readClaudeConfig(), cwd, deps.caseInsensitivePaths);
      // lstat, never stat: a planted .mcp.json link to a share must not be followed.
      const hasProjectMcp = await projectMcpConfigNear(cwd, (path) => lstat(path), deps.log);
      return trustPromptExpected({ claudeTrustsExactly: exact, hasProjectMcp });
    },

    resolveProjectCwd,

    async trustedLeadFolder(leadId, cwd, projects) {
      const project = projects?.find((p) => leadAgentIdFor(p) === leadId);
      if (!project?.trusted) return null;
      const folder = await resolveProjectCwd(project.path);
      const actual = await resolveProjectCwd(cwd);
      if (!folder || !actual || !samePath(folder, actual)) return null;
      return (await repoRoot(folder)) === project.trustedRoot ? folder : null;
    },

    async stillLeadFolder(cwd, folder) {
      const actual = await resolveProjectCwd(cwd);
      return !!actual && samePath(actual, folder);
    },

    repoRoot,

    async trustState(project, cwd) {
      if (!project.trusted) return 'none';
      const out = await deps.rootCommitsOutput(cwd);
      if (out === null) return 'unknown';
      return trustedRootFrom(out) === project.trustedRoot ? 'trusted' : 'stale';
    },

    // Main's own revokes (stale repo, failed spawn) drop stored trust first: it must go even when Claude's config cannot.
    async revokeTrust(project, cwd) {
      const saved = dropStoredTrust(project);
      return (await forgetClaudeTrustOf(project, cwd)) && saved;
    },

    async forgetTrust(project, cwd) {
      if (!(await forgetClaudeTrustOf(project, cwd))) return false;
      return dropStoredTrust(project);
    },

    touchLead(agentId) {
      leadUsedAt.set(agentId, now());
    },

    leadLastUsed(agentId) {
      return leadUsedAt.get(agentId) ?? 0;
    },

    setLeadShown(agentId, window, shown) {
      leadUsedAt.set(agentId, now());
      const windows = shownIn.get(agentId) ?? new Set<number>();
      if (shown) windows.add(window.id);
      else windows.delete(window.id);
      if (windows.size > 0) shownIn.set(agentId, windows);
      else shownIn.delete(agentId);
      if (shown && !watchedWindows.has(window.id)) {
        const id = window.id;
        watchedWindows.add(id);
        window.once('destroyed', () => {
          watchedWindows.delete(id);
          for (const [lead, set] of shownIn) {
            set.delete(id);
            if (set.size === 0) shownIn.delete(lead);
          }
        });
      }
    },

    isLeadShown(agentId) {
      return (shownIn.get(agentId)?.size ?? 0) > 0;
    },

    ownLead(agentId, owner) {
      leadOwners.set(agentId, owner);
      // A closed window must not stay referenced by a lead that is never stopped.
      owner.once('destroyed', () => {
        if (leadOwners.get(agentId) === owner) leadOwners.delete(agentId);
      });
    },

    leadWindow,

    archiveLeadCard(agentId) {
      const target = leadWindow(agentId);
      leadOwners.delete(agentId);
      try {
        target?.send('hive:agentArchived', { id: agentId });
      } catch (e) {
        deps.log(`[room] archive of ${agentId} not sent: ${errText(e)}`);
      }
    },

    announceLead(id, name, cwd, target) {
      try {
        if (target && !target.isDestroyed()) target.send('hive:agentSpawned', { id, name, provider: 'claude', cwd, command: 'claude', role: 'lead' });
      } catch (e) {
        deps.log(`[room] announce of ${id} not sent: ${errText(e)}`);
      }
    }
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
