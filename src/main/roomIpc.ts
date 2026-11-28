// `room:*` IPC for project rooms (ADR 0005). Every call takes a project id; paths,
// commands and the lead's id are resolved here from the project record.

import { ipcMain, type WebContents } from 'electron';
import { isValidProjectId, type Project } from '../shared/project';
import {
  buildLeadSpawn,
  isLeadAgentId,
  leadAgentIdFor,
  parseOpenRequest,
  sameOpenRequest,
  type LeadSpawnOptions,
  type OpenRequest,
  type OpenTerminalResult,
  type RoomDone,
  type RoomResult
} from '../shared/roomLead';
import { isValidSessionId, type SessionSummary } from '../shared/sessionList';
import type { RoomTickets } from '../shared/ticketSources';
import type { LeadLock } from './leadLock';
import type { TrustRevoke } from './roomWiring';

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
  patchProject: (projectId: string, patch: { leadAgentId?: string; trustedPath?: string | null; trustedRoot?: string | null }) => boolean;
  /** Whether stored trust still holds for the repo now in `cwd` (ADR 0007). */
  trustState: (project: Project, cwd: string) => Promise<'trusted' | 'stale' | 'unknown' | 'none'>;
  /** Drops the project's trust and Claude's folder trust; false when a part was not saved. */
  revokeTrust: (project: Project, cwd: string | null) => Promise<TrustRevoke>;
  /** The person's "Forget trust": stored trust is dropped only after Claude's (ADR 0012). */
  forgetTrust: (project: Project, cwd: string | null) => Promise<boolean>;
  /** Drops Claude folder trust an earlier revoke could not (ADR 0018); true when none is pending. */
  retryClaudeTrustDrop: (project: Project) => Promise<boolean>;
  /** The stored form of the repo's root commits in `cwd`, or null (no git, no commit). */
  repoRoot: (cwd: string) => Promise<string | null>;
  killLead: (agentId: string) => { ok: boolean; error?: string };
  /** Ids of lead PTYs that are alive now. */
  liveLeadIds: () => string[];
  /** Live room lead terminals allowed at once (config `roomPtyCap`). */
  roomPtyCap: () => number;
  /** Notes that the person used this lead's terminal now (opened it, typed in it). */
  touchLead: (agentId: string) => void;
  /** Epoch ms the lead's terminal was last used, or 0 when never seen. */
  leadLastUsed: (agentId: string) => number;
  /** Removes the lead's card from the window; harmless when it is already gone. */
  archiveLead: (agentId: string) => void;
  /** The agent's last recorded CLI session id, if any. */
  lastSession: (agentId: string) => string | null;
  /** Shared with main's `pty:spawn`, so a restored lead and a forget never overlap (ADR 0017). */
  leadLock: LeadLock;
  log: (line: string) => void;
}

export interface RoomHandlers {
  sessions: (projectId: unknown) => Promise<RoomResult<{ sessions: SessionSummary[] }>>;
  tickets: (projectId: unknown) => Promise<RoomResult<{ tickets: RoomTickets }>>;
  openTerminal: (projectId: unknown, request: unknown, sender: WebContents | null) => Promise<OpenTerminalResult>;
  /**
   * `onlyIf` (main only, never from IPC): checked right before the kill; false
   * leaves the lead running and answers `busy`. Idle shutdown passes its re-check.
   */
  closeTerminal: (projectId: unknown, onlyIf?: () => boolean) => Promise<RoomDone>;
  /** Drops the project's stored trust and Claude's folder trust (ADR 0012); refused while its lead runs or opens. */
  forgetTrust: (projectId: unknown) => Promise<RoomDone>;
  /**
   * Restore team, card restart and auto-revive (ADR 0019): stops a running lead,
   * then opens it again on its last session, through the same checks as an open.
   */
  restartLead: (leadId: unknown, sender: WebContents | null) => Promise<OpenTerminalResult>;
}

export function createRoomHandlers(deps: RoomDeps): RoomHandlers {
  // One open per room at a time; a second click shares the first one's result.
  const opening = new Map<string, { request: OpenRequest; result: Promise<OpenTerminalResult>; sender: WebContents | null }>();

  /** Rooms exist for enabled projects only; closing also works after a project is disabled. */
  const findProject = async (projectId: unknown, enabledOnly: boolean): Promise<Project | null> => {
    if (typeof projectId !== 'string' || !isValidProjectId(projectId)) return null;
    const project = (await deps.projects()).find((p) => p.id === projectId) ?? null;
    return project && (!enabledOnly || project.enabled) ? project : null;
  };

  /**
   * `beforeSpawn` runs once every check passed and before the spawn; a non-null
   * answer ends the open with it. A restart stops the old lead there (ADR 0019).
   */
  const open = async (
    seen: Project,
    request: OpenRequest,
    sender: WebContents | null,
    beforeSpawn?: () => Promise<OpenTerminalResult | null>
  ): Promise<OpenTerminalResult> => {
    // Read again under the lock: an open that ran meanwhile may have revoked trust and left a drop pending (ADR 0018).
    const project = await findProject(seen.id, true);
    if (!project) return { ok: false, error: 'unknown-project' };
    const agentId = leadAgentIdFor(project);
    const cwd = await deps.resolveProjectCwd(project.path);
    if (!cwd) return { ok: false, error: 'project-moved' };
    const full = await capReached(project);
    if (full) return full;
    // Claude still trusts a folder main revoked: a lead now would start the repo's hooks
    // and MCP servers without Claude's prompt, so nothing opens until that is gone (ADR 0018).
    if (!(await deps.retryClaudeTrustDrop(project))) {
      deps.log(`[room] Claude folder trust of ${project.id} still to drop; not opening`);
      return { ok: false, error: 'trust-cleanup-failed' };
    }
    // Stored trust holds only for the repo it was given to (ADR 0007). Another repo
    // in the folder drops it, Claude's own folder trust included, and asks again.
    const state = await deps.trustState(project, cwd);
    if (state === 'stale') {
      deps.log(`[room] ${project.id} holds another repo than the one trusted; trust dropped`);
      const revoked = await deps.revokeTrust(project, cwd);
      if (!revoked.claude) return { ok: false, error: 'trust-cleanup-failed' };
      // Claude's part is gone, so the stale stored trust is never used; the next open drops it again.
      if (!revoked.stored) deps.log(`[room] stored trust for ${project.id} not dropped; asking anyway`);
    }
    // Git could not be asked: keep the stored trust, but do not use it for this open.
    if (state === 'unknown') deps.log(`[room] could not read the root commit of ${project.id}; asking again, trust kept`);
    // Ask when no answer was given, and again when the project now points at a
    // different folder than the one the person said "yes" to.
    if (state !== 'trusted' && (request.trust === null || (request.trust === 'yes' && request.trustPath !== project.path))) {
      if (request.trust === 'yes') deps.log(`[room] trust answer for ${project.id} named another folder; asking again`);
      return { ok: false, error: 'needs-trust', path: project.path, claudeTrusts: await deps.claudeTrusts(cwd) };
    }
    if (request.sessionId !== null) {
      const summary = await deps.sessions.summaryOf(project.path, request.sessionId);
      if (!summary) return { ok: false, error: 'unknown-session' };
      if (summary.large && !request.confirmLarge) return { ok: false, error: 'large-session', contextTokens: summary.contextTokens };
    }
    if (beforeSpawn) {
      const stopped = await beforeSpawn();
      if (stopped) return stopped;
    }
    // Saved only once every check passed, so a refused open stores nothing. Main
    // re-reads trust at spawn, so an unsaved "yes" opens untrusted, and says so.
    let trusted = state === 'trusted';
    const grantedNow = !trusted && request.trust === 'yes';
    if (grantedNow) {
      // A repo with no commit cannot be told from a re-clone: it opens untrusted.
      const root = await deps.repoRoot(cwd);
      trusted = root !== null && deps.patchProject(project.id, { trustedPath: project.path, trustedRoot: root });
      if (!trusted) deps.log(`[room] could not store trust for ${project.id}${root ? '' : ' (no root commit)'}; opening untrusted`);
    }
    const res = await deps.spawnLead(buildLeadSpawn(project, cwd, request.sessionId, trusted), sender);
    if (!res.ok) {
      deps.log(`[room] lead spawn failed for ${project.id}: ${res.error ?? 'no detail'}`);
      // A "yes" to an open that never ran is not kept: the next open asks again.
      // The spawn may already have pre-accepted Claude's folder trust, so drop that too.
      if (grantedNow && trusted) {
        const revoked = await deps.revokeTrust(project, cwd);
        if (!revoked.stored || !revoked.claude) deps.log(`[room] could not fully undo trust for ${project.id} after a failed spawn`);
      }
      return { ok: false, error: res.resumeNotFound ? 'session-not-found' : 'spawn-failed' };
    }
    if (project.leadAgentId !== agentId && !deps.patchProject(project.id, { leadAgentId: agentId })) {
      deps.log(`[room] could not store the lead id of ${project.id}`);
    }
    deps.touchLead(agentId);
    return { ok: true, agentId, alreadyRunning: false, untrusted: !trusted };
  };

  /**
   * The answer when `roomPtyCap` lead terminals already run or are opening
   * (ADR 0005), naming the least recently used live one to stop; null while
   * there is room. A lead whose project is gone cannot be stopped from a room,
   * so it does not count. Only live leads can be offered; when the cap is full
   * of opens still in flight, the person retries.
   */
  const capReached = async (project: Project): Promise<OpenTerminalResult | null> => {
    const cap = deps.roomPtyCap();
    const projects = await deps.projects();
    const live = deps.liveLeadIds()
      .map((id) => projects.find((p) => leadAgentIdFor(p) === id))
      .filter((p): p is Project => p !== undefined && p.id !== project.id);
    // Only opens that started earlier count, so two opens at once do not both refuse.
    const queued = [...opening.keys()];
    const self = queued.indexOf(project.id);
    const inFlight = (self < 0 ? queued : queued.slice(0, self)).filter((id) => !live.some((p) => p.id === id)).length;
    if (live.length + inFlight < cap) return null;
    const lru = live.reduce<Project | null>((best, p) =>
      !best || deps.leadLastUsed(leadAgentIdFor(p)) < deps.leadLastUsed(leadAgentIdFor(best)) ? p : best, null);
    if (!lru) return { ok: false, error: 'busy' };
    deps.log(`[room] ${cap} lead terminals open; offering to stop ${lru.id} for ${project.id}`);
    return { ok: false, error: 'room-cap', cap, closeProjectId: lru.id, closeName: lru.name };
  };

  /** Runs an open under the lead's `open` hold, recorded so a close or a second click waits for it. */
  const startOpen = (
    project: Project,
    request: OpenRequest,
    sender: WebContents | null,
    beforeSpawn?: () => Promise<OpenTerminalResult | null>
  ): Promise<OpenTerminalResult> => {
    const locked = deps.leadLock.run(leadAgentIdFor(project), 'open', () => open(project, request, sender, beforeSpawn));
    if (!locked) return Promise.resolve({ ok: false, error: 'busy' });
    const result = locked.catch((e): OpenTerminalResult => {
      deps.log(`[room] open terminal failed for ${project.id}: ${errText(e)}`);
      return { ok: false, error: 'spawn-failed' };
    }).finally(() => opening.delete(project.id));
    opening.set(project.id, { request, result, sender });
    return result;
  };

  const handlers: RoomHandlers = {
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
        deps.touchLead(agentId);
        deps.announceLead(agentId, `${project.name} lead`, (await deps.resolveProjectCwd(project.path)) ?? project.path, sender);
        return { ok: true, agentId, alreadyRunning: true, untrusted: !project.trusted };
      }
      // A forget or a pty spawn of this lead holds it. Only opens, spawns and forgets take
      // the lock: a close never reads trust, and main's own revokes run inside an open.
      const held = deps.leadLock.holder(agentId);
      if (held === 'forget' || held === 'spawn') return { ok: false, error: 'busy' };
      const pending = opening.get(project.id);
      // A double click shares the open; a different request waits for the person to retry.
      if (pending) {
        if (!sameOpenRequest(pending.request, parsed)) return { ok: false, error: 'busy' };
        const shared = await pending.result;
        // The open announced the card to its own window; another window needs its own.
        if (shared.ok && sender !== pending.sender) {
          deps.announceLead(agentId, `${project.name} lead`, (await deps.resolveProjectCwd(project.path)) ?? project.path, sender);
        }
        return shared;
      }
      return startOpen(project, parsed, sender);
    },

    async closeTerminal(projectId, onlyIf) {
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
      if (onlyIf && !onlyIf()) return { ok: false, error: 'busy' };
      const res = deps.killLead(agentId);
      if (!res.ok) {
        deps.log(`[room] stop failed for ${project.id}: ${res.error ?? 'no detail'}`);
        return { ok: false, error: 'stop-failed' };
      }
      return { ok: true, done: true };
    },

    async forgetTrust(projectId) {
      const project = await findProject(projectId, false);
      if (!project) return { ok: false, error: 'unknown-project' };
      // A running lead already loaded the folder's hooks and MCP servers, and its
      // hook gate reads trust on every hook: the person stops it first.
      // A held lead is being opened, spawned through pty:spawn or forgotten (ADR 0017).
      const agentId = leadAgentIdFor(project);
      if (deps.leadLock.holder(agentId) !== null || deps.isRunning(agentId)) return { ok: false, error: 'busy' };
      // Nothing of ours to drop. Claude's own trust for the folder may be the person's, so it stays.
      if (!project.trusted && project.claudeTrustToDrop.length === 0) return { ok: true, done: true };
      const forgotten = deps.leadLock.run(agentId, 'forget', async (): Promise<RoomDone> => {
        try {
          // Read again under the lock, then what an earlier revoke left behind goes first (ADR 0018).
          const project = await findProject(projectId, false);
          if (!project) return { ok: false, error: 'unknown-project' };
          if (!(await deps.retryClaudeTrustDrop(project))) return { ok: false, error: 'forget-failed' };
          if (!project.trusted) return { ok: true, done: true };
          const cwd = await deps.resolveProjectCwd(project.path);
          // A part not saved leaves the project trusted: the button stays and the person retries.
          if (!(await deps.forgetTrust(project, cwd))) return { ok: false, error: 'forget-failed' };
          deps.log(`[room] trust for ${project.id} forgotten`);
          return { ok: true, done: true };
        } catch (e) {
          deps.log(`[room] forget trust failed for ${project.id}: ${errText(e)}`);
          return { ok: false, error: 'forget-failed' };
        }
      });
      return forgotten ?? { ok: false, error: 'busy' };
    },

    async restartLead(leadId, sender) {
      if (typeof leadId !== 'string' || !isLeadAgentId(leadId)) return { ok: false, error: 'invalid-request' };
      const project = (await deps.projects()).find((p) => p.enabled && leadAgentIdFor(p) === leadId) ?? null;
      if (!project) return { ok: false, error: 'unknown-project' };
      if (deps.leadLock.holder(leadId) !== null || opening.has(project.id)) return { ok: false, error: 'busy' };
      // The last session, while the project still lists it; else the lead starts a new one.
      const last = deps.lastSession(leadId);
      const listed = last !== null && isValidSessionId(last) && (await deps.sessions.summaryOf(project.path, last)) !== null;
      if (last !== null && !listed) deps.log(`[room] last session of ${leadId} is not listed any more; starting a new one`);
      // A restart continues work the person already ran, so a large session is not asked again.
      const request: OpenRequest = { sessionId: listed ? last : null, confirmLarge: true, trust: null, trustPath: null };
      // The old lead stops only once every open check passed, under the same hold as the spawn:
      // a refused restart leaves it running, and no forget or other open lands in between.
      return startOpen(project, request, sender, async () => {
        if (!deps.isRunning(leadId)) {
          // A stopped card still holds the dead terminal: clear it so the new lead paints on a fresh one.
          deps.archiveLead(leadId);
          return null;
        }
        const res = deps.killLead(leadId);
        if (res.ok) return null;
        deps.log(`[room] restart could not stop ${leadId}: ${res.error ?? 'no detail'}`);
        return { ok: false, error: 'stop-failed' };
      });
    }
  };
  return handlers;
}

export function registerRoomIpc(handlers: RoomHandlers): void {
  ipcMain.handle('room:sessions', (_evt, projectId: unknown) => handlers.sessions(projectId));
  ipcMain.handle('room:tickets', (_evt, projectId: unknown) => handlers.tickets(projectId));
  ipcMain.handle('room:openTerminal', (evt, projectId: unknown, request: unknown) =>
    handlers.openTerminal(projectId, request, evt.sender));
  ipcMain.handle('room:closeTerminal', (_evt, projectId: unknown) => handlers.closeTerminal(projectId));
  ipcMain.handle('room:forgetTrust', (_evt, projectId: unknown) => handlers.forgetTrust(projectId));
  ipcMain.handle('room:restartLead', (evt, leadId: unknown) => handlers.restartLead(leadId, evt.sender));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
