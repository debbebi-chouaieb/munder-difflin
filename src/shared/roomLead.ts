// The project lead's terminal, opened from its room (ADR 0003 amended, ADR 0005).
// Pure: main turns a project record into spawn options. The renderer only ever
// sends a project id, an optional session id and the person's trust answer.

import { isValidSessionId } from './sessionList';

/**
 * Room leads use `lead--<projectId>`. Add Agent ids are `<slug>-<time>` and the
 * slug collapses dash runs, so no hand-hired agent (say one named "Lead Dev") can
 * ever carry this prefix and be mistaken for a lead.
 */
const LEAD_PREFIX = 'lead--';
const LEAD_ID = /^lead--[a-z0-9][a-z0-9-]{0,80}$/;

/** Fixed codes so the renderer can translate them; details stay in the main log. */
export const ROOM_ERROR_CODES = [
  'unknown-project',
  'invalid-request',
  'unknown-session',
  'large-session',
  'needs-trust',
  'project-moved',
  'session-not-found',
  'spawn-failed',
  'stop-failed',
  'read-failed',
  'busy'
] as const;
export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

export type RoomFailure =
  | { ok: false; error: Exclude<RoomErrorCode, 'large-session' | 'needs-trust'> }
  | { ok: false; error: 'large-session'; contextTokens: number | null }
  /**
   * `path`: the folder "Trust" would store; the dialog shows it and a "yes" sends it
   * back. `claudeTrusts`: Claude already trusts this folder or a parent, so opening
   * without trust will not ask and the folder's hooks and MCP servers still run.
   */
  | { ok: false; error: 'needs-trust'; path: string; claudeTrusts: boolean };

export type RoomResult<T> = ({ ok: true } & T) | RoomFailure;
export type RoomDone = RoomResult<{ done: true }>;
/** `untrusted`: the lead runs without folder-trust pre-accept and auto mode, also after a "yes" that could not be saved. */
export type OpenTerminalResult = RoomResult<{ agentId: string; alreadyRunning: boolean; untrusted: boolean }>;

/** Longest folder path a trust answer may carry. */
const MAX_TRUST_PATH = 4096;

export interface OpenTerminalRequest {
  /** Null or absent starts a new session. */
  sessionId?: string | null;
  /** The person already confirmed resuming a large session. */
  confirmLarge?: boolean;
  /**
   * The answer to "Trust this project?" for a project not yet trusted.
   * 'yes' is stored on the project; 'no' opens this once without pre-accepting
   * Claude's folder trust and without auto mode, so Claude asks in the terminal.
   */
  trust?: 'yes' | 'no';
  /** With trust 'yes': the `path` from `needs-trust`, the folder the person saw. Required then. */
  trustPath?: string;
}

export interface OpenRequest {
  sessionId: string | null;
  confirmLarge: boolean;
  trust: 'yes' | 'no' | null;
  trustPath: string | null;
}

/** Same terminal size as other agents get before the first fit. */
const LEAD_COLS = 100;
const LEAD_ROWS = 30;

export interface LeadProject {
  id: string;
  name: string;
  leadAgentId: string | null;
}

/** What a spawn may grant. Untrusted: no folder-trust pre-accept and no auto-mode bypass flag. */
export function spawnPosture(untrusted: boolean, autoMode: boolean): { preAcceptTrust: boolean; autoMode: boolean } {
  return { preAcceptTrust: !untrusted, autoMode: autoMode && !untrusted };
}

/** Cheap, sync: only these spawns need the project list. */
export function isLeadAgentId(agentId: string): boolean {
  return agentId.startsWith(LEAD_PREFIX);
}

/**
 * Main decides trust for every lead spawn, whatever path started it (room,
 * Restore team, a card restart). A lead runs trusted only when its project is
 * trusted; a lead whose project cannot be found (or a project list that did not
 * arrive in time, passed as null) runs untrusted: fail closed.
 */
export function leadMustRunUntrusted(
  agentId: string,
  projects: ReadonlyArray<Pick<LeadProject, 'id' | 'leadAgentId'> & { trusted: boolean }> | null
): boolean {
  if (!isLeadAgentId(agentId)) return false;
  const project = projects?.find((p) => leadAgentIdFor(p) === agentId);
  return !project?.trusted;
}

/**
 * Claude args without any permission bypass. A card restart or Restore team
 * replays args that the renderer built with auto mode baked in; for an untrusted
 * lead those must go, not only stay un-added.
 */
export function withoutClaudeBypassArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dangerously-skip-permissions' || a === '--allow-dangerously-skip-permissions') continue;
    if (a === '--permission-mode') { i++; continue; }
    if (a.startsWith('--permission-mode=')) continue;
    out.push(a);
  }
  return out;
}

export interface LeadSpawnOptions {
  id: string;
  cwd: string;
  command: 'claude';
  cols: number;
  rows: number;
  provider: 'claude';
  /** False for a new session, so the registry's last session is not picked up. */
  resume: boolean;
  /** A chosen session that cannot be resumed is an error, not a silent new session. */
  requireResume: boolean;
  resumeSessionId?: string;
  /** No folder-trust pre-accept and no auto-mode flag (ADR 0005). */
  untrusted: boolean;
  hive: { id: string; name: string; role: 'lead'; cwd: string; provider: 'claude' };
}

/** The stored lead id when it is one we made, else `lead--<projectId>`. */
export function leadAgentIdFor(project: Pick<LeadProject, 'id' | 'leadAgentId'>): string {
  return project.leadAgentId && LEAD_ID.test(project.leadAgentId) ? project.leadAgentId : `${LEAD_PREFIX}${project.id}`;
}

/**
 * Options for the existing agent spawn path. `cwd` is the project folder's real
 * path, checked by the caller. `sessionId` null starts a new session.
 */
export function buildLeadSpawn(project: LeadProject, cwd: string, sessionId: string | null, trusted: boolean): LeadSpawnOptions {
  if (sessionId !== null && !isValidSessionId(sessionId)) throw new Error('invalid session id');
  const id = leadAgentIdFor(project);
  const resume = sessionId !== null;
  return {
    id,
    cwd,
    command: 'claude',
    cols: LEAD_COLS,
    rows: LEAD_ROWS,
    provider: 'claude',
    resume,
    requireResume: resume,
    ...(resume ? { resumeSessionId: sessionId } : {}),
    untrusted: !trusted,
    hive: { id, name: `${project.name} lead`, role: 'lead', cwd, provider: 'claude' }
  };
}

/** Parses the renderer's request; null when any field is malformed. */
export function parseOpenRequest(request: unknown): OpenRequest | null {
  if (request === undefined || request === null) return { sessionId: null, confirmLarge: false, trust: null, trustPath: null };
  if (typeof request !== 'object' || Array.isArray(request)) return null;
  const { sessionId, confirmLarge, trust, trustPath } = request as OpenTerminalRequest;
  if (sessionId !== undefined && sessionId !== null && !isValidSessionId(sessionId)) return null;
  if (confirmLarge !== undefined && typeof confirmLarge !== 'boolean') return null;
  if (trust !== undefined && trust !== 'yes' && trust !== 'no') return null;
  if (trustPath !== undefined && (typeof trustPath !== 'string' || trustPath.length === 0 || trustPath.length > MAX_TRUST_PATH)) return null;
  // A "yes" binds to the folder the person was shown; without it there is nothing to bind.
  if (trust === 'yes' && trustPath === undefined) return null;
  return { sessionId: sessionId ?? null, confirmLarge: confirmLarge === true, trust: trust ?? null, trustPath: trustPath ?? null };
}

export function sameOpenRequest(a: OpenRequest, b: OpenRequest): boolean {
  return a.sessionId === b.sessionId && a.confirmLarge === b.confirmLarge && a.trust === b.trust && a.trustPath === b.trustPath;
}
