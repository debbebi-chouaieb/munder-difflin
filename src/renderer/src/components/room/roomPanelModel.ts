// The room panel's decisions, kept free of React so they can be tested
// (ADR 0005, ADR 0006). The panel only renders what these return.

import type { OpenTerminalRequest, OpenTerminalResult, RoomErrorCode, RoomResult } from '@shared/roomLead';

/** i18n key for a code; every code has a string in every locale (test/room-panel.test.cjs). */
export function roomErrorKey(code: RoomErrorCode): string {
  return `room.errors.${code}`;
}

/**
 * The error key for one settled room read. A rejected call (main gone, IPC torn
 * down) is logged with its reason and shown as a read failure.
 */
export function readErrorKey(what: string, settled: PromiseSettledResult<RoomResult<object>>, log: (line: string) => void): string | null {
  if (settled.status === 'rejected') {
    const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    log(`[room] ${what} failed: ${reason}`);
    return roomErrorKey('read-failed');
  }
  return settled.value.ok ? null : roomErrorKey(settled.value.error);
}

/** What the panel does after one `room:openTerminal` answer. */
export type OpenStep =
  /** `trustNotSaved`: the person said "Trust" but it could not be stored, so the lead runs untrusted. */
  | { kind: 'opened'; agentId: string; trustNotSaved: boolean }
  /** Ask "Trust this project?" about `path`; `claudeTrusts`: Claude will not ask in the terminal. */
  | { kind: 'ask-trust'; request: OpenTerminalRequest; path: string; claudeTrusts: boolean }
  /** Ask before resuming a large session; `contextTokens` null when the size is unknown. */
  | { kind: 'confirm-large'; request: OpenTerminalRequest; contextTokens: number | null }
  | { kind: 'failed'; errorKey: string };

export function openStep(request: OpenTerminalRequest, result: OpenTerminalResult): OpenStep {
  if (result.ok) return { kind: 'opened', agentId: result.agentId, trustNotSaved: request.trust === 'yes' && result.untrusted };
  switch (result.error) {
    case 'needs-trust':
      return { kind: 'ask-trust', request, path: result.path, claudeTrusts: result.claudeTrusts };
    case 'large-session':
      return { kind: 'confirm-large', request, contextTokens: result.contextTokens };
    default:
      return { kind: 'failed', errorKey: roomErrorKey(result.error) };
  }
}

/** The trust answer, added to the same request. "Trust" names the folder the dialog showed. */
export function withTrust(request: OpenTerminalRequest, answer: 'yes' | 'no', shownPath: string): OpenTerminalRequest {
  const next: OpenTerminalRequest = { ...request, trust: answer };
  if (answer === 'yes') next.trustPath = shownPath;
  else delete next.trustPath;
  return next;
}

/** "Resume anyway" keeps the session; "New session" drops it and the confirmation. */
export function afterLargeAnswer(request: OpenTerminalRequest, answer: 'resume' | 'new'): OpenTerminalRequest {
  return answer === 'resume'
    ? { ...request, confirmLarge: true }
    : { ...request, sessionId: null, confirmLarge: false };
}

/** What the right panel shows: a selected room wins over the selected agent. */
export type RightPanelView = 'room' | 'agent' | 'none';

export function rightPanelView(selectedRoomId: string | null, hasSelectedAgent: boolean): RightPanelView {
  if (selectedRoomId !== null) return 'room';
  return hasSelectedAgent ? 'agent' : 'none';
}

/** A context size as the session list shows it: 999, 1k, 12.3k, 150k. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  return `${k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/** The ZetaHub cache time in the viewer's locale; the raw text when it is not a date. */
export function formatSyncedAt(syncedAt: string, locale: string): string {
  const ms = Date.parse(syncedAt);
  return Number.isNaN(ms) ? syncedAt : new Date(ms).toLocaleString(locale);
}
