// Main-side plumbing for project rooms (ADR 0005, ADR 0007): Claude's own folder
// trust, the project folder check, and which window owns each lead's card.
// Kept out of index.ts so it can be unit tested with a temp home folder.

import { join } from 'node:path';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { samePath, trustedRootFrom, type Project, type StoredProjectPatch } from '../shared/project';
import { leadAgentIdFor } from '../shared/roomLead';
import { claudeTrustCovers, claudeTrustsExactly, projectMcpConfigNear, trustPromptExpected } from '../shared/claudeTrust';
import { resolveAllowedRoot } from './rootGuard';

export const CLAUDE_CONFIG_MAX_BYTES = 32 * 1024 * 1024;

export interface RoomWiringDeps {
  homedir: () => string;
  caseInsensitivePaths: boolean;
  workspaceRoot: () => string | null | undefined;
  liveWebContents: () => WebContents | null;
  /** Raw `git rev-list --max-parents=0 HEAD` output in `cwd`, or null when git failed. */
  rootCommitsOutput: (cwd: string) => Promise<string | null>;
  /** Saves stored project fields; false when the write failed. */
  patchProject: (projectId: string, patch: StoredProjectPatch) => boolean;
  log: (line: string) => void;
}

/** `none`: never trusted; `stale`: trusted, but the folder now holds another repo (or none). */
export type TrustState = 'trusted' | 'stale' | 'none';

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
  /** Records the window that opened a lead, so its archive goes where its card was made. */
  ownLead: (agentId: string, owner: WebContents) => void;
  leadWindow: (agentId: string) => WebContents | null;
  /** Tells the lead's window to archive its card; the renderer ignores an unknown id. */
  archiveLeadCard: (agentId: string) => void;
  announceLead: (id: string, name: string, cwd: string, target: WebContents | null) => void;
}

export function createRoomWiring(deps: RoomWiringDeps): RoomWiring {
  const leadOwners = new Map<string, WebContents>();

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

  /** Drops `hasTrustDialogAccepted` from both spellings of `folder`'s key; parents were never written by the app. */
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
      let changed = false;
      for (const key of new Set([folder.replace(/\\/g, '/'), folder])) {
        const entry = (projects as Record<string, unknown>)[key];
        if (entry && typeof entry === 'object' && 'hasTrustDialogAccepted' in entry) {
          delete (entry as Record<string, unknown>).hasTrustDialogAccepted;
          changed = true;
        }
      }
      if (changed) await writeFile(file, JSON.stringify(config, null, 2), 'utf8');
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      deps.log(`[room] could not remove folder trust from ~/.claude.json: ${errText(e)}`);
      return false;
    }
  };

  const leadWindow = (agentId: string): WebContents | null => {
    const owner = leadOwners.get(agentId);
    return owner && !owner.isDestroyed() ? owner : deps.liveWebContents();
  };

  return {
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
      const root = await repoRoot(cwd);
      return root !== null && root === project.trustedRoot ? 'trusted' : 'stale';
    },

    async revokeTrust(project, cwd) {
      const saved = deps.patchProject(project.id, { trustedPath: null, trustedRoot: null });
      if (!saved) deps.log(`[room] could not drop trust for ${project.id}`);
      // Pre-accept wrote the folder the lead ran in, the resolved one; drop the stored spelling too.
      const folders = cwd && !samePath(cwd, project.path) ? [project.path, cwd] : [project.path];
      let claudeForgot = true;
      for (const folder of folders) claudeForgot = (await forgetClaudeFolderTrust(folder)) && claudeForgot;
      return saved && claudeForgot;
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
