// The room panel's decisions, kept free of React so they can be tested
// (ADR 0005, ADR 0006). The panel only renders what these return.

import type { OpenTerminalRequest, OpenTerminalResult, RoomErrorCode, RoomResult } from '@shared/roomLead';
import type { LocalItem, ZetahubRow } from '@shared/ticketSources';

/** i18n key for a code; every code has a string in every locale (test/room-panel.test.cjs). */
export function roomErrorKey(code: RoomErrorCode): string {
  return `room.errors.${code}`;
}

/**
 * "Forget trust" is offered for a trusted project whose lead is not running (ADR 0012), and
 * while Claude folder trust from a revoke is still to drop, so the person can retry (ADR 0018).
 */
export function canForgetTrust(trusted: boolean, claudeTrustPending: boolean, leadRunning: boolean): boolean {
  return (trusted || claudeTrustPending) && !leadRunning;
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
  /** The room terminal cap is reached: offer to stop the least recently used lead, then open. */
  | { kind: 'confirm-cap'; request: OpenTerminalRequest; cap: number; closeProjectId: string; closeName: string }
  | { kind: 'failed'; errorKey: string };

export function openStep(request: OpenTerminalRequest, result: OpenTerminalResult): OpenStep {
  if (result.ok) return { kind: 'opened', agentId: result.agentId, trustNotSaved: request.trust === 'yes' && result.untrusted };
  switch (result.error) {
    case 'needs-trust':
      return { kind: 'ask-trust', request, path: result.path, claudeTrusts: result.claudeTrusts };
    case 'large-session':
      return { kind: 'confirm-large', request, contextTokens: result.contextTokens };
    case 'room-cap':
      return { kind: 'confirm-cap', request, cap: result.cap, closeProjectId: result.closeProjectId, closeName: result.closeName };
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

/** One column of a room task section, kanban style. `labelKey` is an i18n key. */
export interface TaskColumn<T> {
  id: string;
  labelKey: string;
  items: T[];
}

const ZETAHUB_STATUS_COLUMNS: ReadonlyArray<{ id: string; statuses: readonly string[] }> = [
  { id: 'todo', statuses: ['To Do'] },
  { id: 'doing', statuses: ['In Progress'] },
  { id: 'review', statuses: ['Waiting for review', 'Ready for testing'] }
];

/**
 * ZetaHub rows by status: To Do, In Progress, Review, always shown so the board
 * keeps its shape; "Other" only when a status fits none (a workflow added later).
 * Rows keep the cache order (priority, then number) inside a column.
 */
export function zetahubColumns<T extends { status: string }>(rows: readonly T[]): TaskColumn<T>[] {
  const columns: TaskColumn<T>[] = ZETAHUB_STATUS_COLUMNS.map((c) => ({ id: c.id, labelKey: `room.tickets.col.${c.id}`, items: [] }));
  const other: T[] = [];
  for (const row of rows) {
    const index = ZETAHUB_STATUS_COLUMNS.findIndex((c) => c.statuses.includes(row.status));
    if (index >= 0) columns[index].items.push(row);
    else other.push(row);
  }
  if (other.length > 0) columns.push({ id: 'other', labelKey: 'room.tickets.col.other', items: other });
  return columns;
}

/** Local items have no status; `HIGH:` is the only grouping they carry. */
export function localColumns<T extends { high: boolean }>(items: readonly T[]): TaskColumn<T>[] {
  return [
    { id: 'high', labelKey: 'room.tickets.col.high', items: items.filter((i) => i.high) },
    { id: 'normal', labelKey: 'room.tickets.col.normal', items: items.filter((i) => !i.high) }
  ];
}

/**
 * The stored ZetaHub choice for a click on "Show ZetaHub": a choice that matches
 * what auto would do is stored as null, so the project follows its key again.
 */
export function showZetahubSetting(show: boolean, hasZetahubKey: boolean): boolean | null {
  return show === hasZetahubKey ? null : show;
}

/** Smallest terminal height the room splitter leaves, so the lead's prompt stays usable. */
export const ROOM_TERMINAL_MIN_HEIGHT = 120;

/**
 * Height of the room's upper part (sessions and tasks) after a drag of the
 * splitter above the lead terminal. 0 hides it, giving the terminal the panel.
 */
export function nextRoomTopHeight(startHeight: number, dragPx: number, panelHeight: number): number {
  const max = Math.max(0, panelHeight - ROOM_TERMINAL_MIN_HEIGHT);
  return Math.round(Math.min(max, Math.max(0, startHeight + dragPx)));
}

/** The card the person opened in the ticket details dialog (ADR 0016). */
export type TicketDetail = { kind: 'zetahub'; row: ZetahubRow } | { kind: 'local'; item: LocalItem };

/**
 * One line of the details dialog. `labelKey` is an i18n key; `value` is untrusted
 * text already cleaned by ticketSources; `isolate` marks a key or time that must
 * keep its own direction inside an RTL layout.
 */
export interface DetailField {
  labelKey: string;
  value: string;
  isolate: boolean;
}

/** The lines the dialog shows, in order; a field with no value is left out, not shown empty. */
export function ticketDetailFields(detail: TicketDetail, locale: string): DetailField[] {
  const fields: Array<[string, string | null, boolean]> = detail.kind === 'zetahub'
    ? [
        ['room.details.type', detail.row.type || null, false],
        ['room.details.status', detail.row.status, false],
        ['room.details.priority', detail.row.priority || null, false],
        ['room.details.assignee', detail.row.assignee, false],
        ['room.details.milestone', detail.row.milestone, false],
        ['room.details.parent', detail.row.parentKey, true],
        ['room.details.updated', detail.row.updatedAt && formatSyncedAt(detail.row.updatedAt, locale), true]
      ]
    : [['room.details.source', detail.item.source, true]];
  return fields
    .filter((f): f is [string, string, boolean] => typeof f[1] === 'string' && f[1].length > 0)
    .map(([labelKey, value, isolate]) => ({ labelKey, value, isolate }));
}
