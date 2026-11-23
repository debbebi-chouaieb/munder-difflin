// Main-side plumbing for project rooms (ADR 0005, ADR 0007): Claude's own folder
// trust, the project folder check, and which window owns each lead's card.
// Kept out of index.ts so it can be unit tested with a temp home folder.

import { join } from 'node:path';
import { lstat, readFile, stat } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { claudeTrustCovers, claudeTrustsExactly, projectMcpConfigNear, trustPromptExpected } from '../shared/claudeTrust';
import { resolveAllowedRoot } from './rootGuard';

export const CLAUDE_CONFIG_MAX_BYTES = 32 * 1024 * 1024;

export interface RoomWiringDeps {
  homedir: () => string;
  caseInsensitivePaths: boolean;
  workspaceRoot: () => string | null | undefined;
  liveWebContents: () => WebContents | null;
  log: (line: string) => void;
}

export interface RoomWiring {
  /** Parsed ~/.claude.json, or null when it is missing, too big or unreadable (then Claude will ask). */
  readClaudeConfig: () => Promise<unknown>;
  /** Claude Code already trusts `cwd` or a parent (~/.claude.json), so it shows no folder-trust dialog there. */
  claudeTrustsFolder: (cwd: string) => Promise<boolean>;
  /** Whether an untrusted lead in `cwd` may meet a startup prompt that Enter would answer "yes". */
  leadMayMeetTrustPrompt: (cwd: string) => Promise<boolean>;
  /** The project folder's real path when it is a plain folder inside the workspace, else null. */
  resolveProjectCwd: (projectPath: string) => Promise<string | null>;
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

    async resolveProjectCwd(projectPath) {
      const root = deps.workspaceRoot();
      if (!root) return null;
      try {
        if ((await lstat(projectPath)).isSymbolicLink()) return null;
      } catch {
        return null;
      }
      return resolveAllowedRoot(projectPath, [root]);
    },

    ownLead(agentId, owner) {
      leadOwners.set(agentId, owner);
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
