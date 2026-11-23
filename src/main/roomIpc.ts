// `room:*` IPC for project rooms (ADR 0005). Every call takes a project id; paths,
// commands and the lead's id are resolved here from the project record.

import { ipcMain, type WebContents } from 'electron';
import { isValidProjectId, type Project } from '../shared/project';
import {
  buildLeadSpawn,
  leadAgentIdFor,
  parseOpenRequest,
  sameOpenRequest,
  type LeadSpawnOptions,
  type OpenRequest,
  type OpenTerminalResult,
  type RoomDone,
  type RoomResult
} from '../shared/roomLead';
import type { SessionSummary } from '../shared/sessionList';
import type { RoomTickets } from '../shared/ticketSources';

export interface RoomDeps {
  projects: () => Promise<Project[]>;
  /** The project folder's real path when it is still a plain folder inside the workspace, else null. */
  resolveProjectCwd: (projectPath: string) => Promise<string | null>;
  /** Claude Code already trusts this folder or a parent (~/.claude.json). */
  claudeTrusts: (cwd: string) => Promise<boolean>;
  sessions: {
    list: (projectPath: string) => Promise<SessionSummary[]>;
    summaryOf: (projectPath: string, sessionId: string) => Promise<SessionSummary | null>;
  };
  tickets: (project: Project) => Promise<RoomTickets>;
  isRunning: (agentId: string) => boolean;
  /** Runs the shared agent spawn and announces the new agent to `sender`'s window. */
  spawnLead: (opts: LeadSpawnOptions, sender: WebContents | null) => Promise<{ ok: boolean; error?: string; resumeNotFound?: boolean }>;
  /** Re-announces a running lead, so a reloaded window gets its card back. */
  announceLead: (agentId: string, name: string, cwd: string, sender: WebContents | null) => void;
  /** Saves stored project fields; false when the write failed. */
  patchProject: (projectId: string, patch: { leadAgentId?: string; trustedPath?: string }) => boolean;
  killLead: (agentId: string) => { ok: boolean; error?: string };
  /** Removes the lead's card from the window; harmless when it is already gone. */
  archiveLead: (agentId: string) => void;
  log: (line: string) => void;
}

export type OpenResult = OpenTerminalResult;

export interface RoomHandlers {
  sessions: (projectId: unknown) => Promise<RoomResult<{ sessions: SessionSummary[] }>>;
  tickets: (projectId: unknown) => Promise<RoomResult<{ tickets: RoomTickets }>>;
  openTerminal: (projectId: unknown, request: unknown, sender: WebContents | null) => Promise<OpenResult>;
  closeTerminal: (projectId: unknown) => Promise<RoomDone>;
}

export function createRoomHandlers(deps: RoomDeps): RoomHandlers {
  // One open per room at a time; a second click shares the first one's result.
  const opening = new Map<string, { request: OpenRequest; result: Promise<OpenResult> }>();

  /** Rooms exist for enabled projects only; closing also works after a project is disabled. */
  const findProject = async (projectId: unknown, enabledOnly: boolean): Promise<Project | null> => {
    if (typeof projectId !== 'string' || !isValidProjectId(projectId)) return null;
    const project = (await deps.projects()).find((p) => p.id === projectId) ?? null;
    return project && (!enabledOnly || project.enabled) ? project : null;
  };

  const open = async (project: Project, request: OpenRequest, sender: WebContents | null): Promise<OpenResult> => {
    const agentId = leadAgentIdFor(project);
    const cwd = await deps.resolveProjectCwd(project.path);
    if (!cwd) return { ok: false, error: 'project-moved' };
    // Ask when no answer was given, and again when the project now points at a
    // different folder than the one the person said "yes" to.
    if (!project.trusted && (request.trust === null || (request.trust === 'yes' && request.trustPath !== project.path))) {
      if (request.trust === 'yes') deps.log(`[room] trust answer for ${project.id} named another folder; asking again`);
      return { ok: false, error: 'needs-trust', path: project.path, claudeTrusts: await deps.claudeTrusts(cwd) };
    }
    if (request.sessionId !== null) {
      const summary = await deps.sessions.summaryOf(project.path, request.sessionId);
      if (!summary) return { ok: false, error: 'unknown-session' };
      if (summary.large && !request.confirmLarge) return { ok: false, error: 'large-session', contextTokens: summary.contextTokens };
    }
    // Saved only once every check passed, so a refused open stores nothing. Main
    // re-reads trust at spawn, so an unsaved "yes" opens untrusted, and says so.
    let trusted = project.trusted;
    if (!trusted && request.trust === 'yes') {
      trusted = deps.patchProject(project.id, { trustedPath: project.path });
      if (!trusted) deps.log(`[room] could not store trust for ${project.id}; opening untrusted`);
    }
    const res = await deps.spawnLead(buildLeadSpawn(project, cwd, request.sessionId, trusted), sender);
    if (!res.ok) {
      deps.log(`[room] lead spawn failed for ${project.id}: ${res.error ?? 'no detail'}`);
      return { ok: false, error: res.resumeNotFound ? 'session-not-found' : 'spawn-failed' };
    }
    if (project.leadAgentId !== agentId && !deps.patchProject(project.id, { leadAgentId: agentId })) {
      deps.log(`[room] could not store the lead id of ${project.id}`);
    }
    return { ok: true, agentId, alreadyRunning: false, untrusted: !trusted };
  };

  return {
    async sessions(projectId) {
      const project = await findProject(projectId, true);
      if (!project) return { ok: false, error: 'unknown-project' };
      try {
        return { ok: true, sessions: await deps.sessions.list(project.path) };
      } catch (e) {
        deps.log(`[room] sessions failed for ${project.id}: ${errText(e)}`);
        return { ok: false, error: 'read-failed' };
      }
    },

    async tickets(projectId) {
      const project = await findProject(projectId, true);
      if (!project) return { ok: false, error: 'unknown-project' };
      // The local table is read from inside the folder: only a plain folder in the workspace.
      const cwd = await deps.resolveProjectCwd(project.path);
      if (!cwd) return { ok: false, error: 'project-moved' };
      try {
        return { ok: true, tickets: await deps.tickets({ ...project, path: cwd }) };
      } catch (e) {
        deps.log(`[room] tickets failed for ${project.id}: ${errText(e)}`);
        return { ok: false, error: 'read-failed' };
      }
    },

    async openTerminal(projectId, request, sender) {
      const project = await findProject(projectId, true);
      if (!project) return { ok: false, error: 'unknown-project' };
      const parsed = parseOpenRequest(request);
      if (!parsed) return { ok: false, error: 'invalid-request' };
      const agentId = leadAgentIdFor(project);
      if (deps.isRunning(agentId)) {
        deps.announceLead(agentId, `${project.name} lead`, (await deps.resolveProjectCwd(project.path)) ?? project.path, sender);
        return { ok: true, agentId, alreadyRunning: true, untrusted: !project.trusted };
      }
      const pending = opening.get(project.id);
      // A double click shares the open; a different request waits for the person to retry.
      if (pending) return sameOpenRequest(pending.request, parsed) ? pending.result : { ok: false, error: 'busy' };
      const result = open(project, parsed, sender).catch((e): OpenResult => {
        deps.log(`[room] open terminal failed for ${project.id}: ${errText(e)}`);
        return { ok: false, error: 'spawn-failed' };
      }).finally(() => opening.delete(project.id));
      opening.set(project.id, { request: parsed, result });
      return result;
    },

    async closeTerminal(projectId) {
      const project = await findProject(projectId, false);
      if (!project) return { ok: false, error: 'unknown-project' };
      // A close during a slow spawn waits for it, so the new process is not left running.
      const pending = opening.get(project.id);
      if (pending) await pending.result;
      const agentId = leadAgentIdFor(project);
      // A lead that exited on its own (answered "no" at Claude's prompt, /exit, a
      // crash) leaves its card behind: Stop clears it so the room is usable again.
      if (!deps.isRunning(agentId)) {
        deps.archiveLead(agentId);
        return { ok: true, done: true };
      }
      const res = deps.killLead(agentId);
      if (!res.ok) {
        deps.log(`[room] stop failed for ${project.id}: ${res.error ?? 'no detail'}`);
        return { ok: false, error: 'stop-failed' };
      }
      return { ok: true, done: true };
    }
  };
}

export function registerRoomIpc(handlers: RoomHandlers): void {
  ipcMain.handle('room:sessions', (_evt, projectId: unknown) => handlers.sessions(projectId));
  ipcMain.handle('room:tickets', (_evt, projectId: unknown) => handlers.tickets(projectId));
  ipcMain.handle('room:openTerminal', (evt, projectId: unknown, request: unknown) =>
    handlers.openTerminal(projectId, request, evt.sender));
  ipcMain.handle('room:closeTerminal', (_evt, projectId: unknown) => handlers.closeTerminal(projectId));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
