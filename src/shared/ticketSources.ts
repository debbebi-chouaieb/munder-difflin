// The two task tables of a project room (ADR 0005). Pure: callers pass file text.
// Table 1 reads the zetahub-sync cache (`tasks/<P>.jsonl`); table 2 reads the
// "## No ticket yet" bullets of the project's local open-work file. Both follow the
// `backlog` skill and `zetahub-cache.sh` so the room and the CLI agree. All text is
// untrusted and is cleaned and capped before it reaches the renderer.

import { cleanText } from './untrustedText';

export const MAX_ZETAHUB_ROWS = 100;
export const MAX_LOCAL_ITEMS = 40;

const MAX_TITLE_CHARS = 160;
const MAX_LABEL_CHARS = 60;
const MAX_ITEM_CHARS = 300;
const MAX_SOURCE_CHARS = 80;
const MAX_TIME_CHARS = 40;

/** Statuses the cache script treats as closed. */
const CLOSED_STATUSES = new Set(['Done', 'Closed', 'Cancelled', 'Canceled']);
const PRIORITY_RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const LOCAL_SECTION = /^##\s+No ticket yet\s*$/i;

export interface ZetahubRow {
  key: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  assignee: string | null;
  milestone: string | null;
  /** The parent ticket's display key, when the parent is in the same cache file. */
  parentKey: string | null;
  /** The cache's `updated_at`, as text (ISO 8601 from ZetaHub). */
  updatedAt: string | null;
}

export interface LocalItem {
  text: string;
  /** The trailing "(source, date)" of a bullet, when present. */
  source: string | null;
  high: boolean;
}

export interface Limited<T> {
  items: T[];
  /** How many matched before the limit was applied. */
  total: number;
}

export type ZetahubTable =
  | { ok: true; key: string; rows: ZetahubRow[]; total: number; syncedAt: string | null }
  | { ok: false; key: string | null; reason: 'hidden' | 'suggested' | 'no-key' | 'no-cache' | 'not-cached' | 'unreadable' };

/**
 * `unavailable` covers a missing file and a path that leaves the project on
 * purpose: a repo's CLAUDE.md must not learn which outside paths exist.
 */
export type LocalTable =
  | { ok: true; path: string; items: LocalItem[]; total: number }
  | { ok: false; reason: 'no-line' | 'unavailable' | 'unreadable' };

export interface RoomTickets {
  zetahub: ZetahubTable;
  local: LocalTable;
}

/** `tasks/<P>.jsonl` file stem: the key without dashes, upper case (MCX-ANDR → MCXANDR). */
export function cacheFileStem(projectKey: string): string {
  return projectKey.replace(/-/g, '').toUpperCase();
}

/** The cache stores some keys with a doubled dash (`MDM--51`); show one. */
export function displayTicketKey(key: string): string {
  return key.replace(/-{2,}/g, '-');
}

/** `{id, name}` or `{id, title}` lines to an id → label map. Bad lines are skipped. */
export function parseLabelMap(jsonl: string, field: 'name' | 'title'): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of jsonLines(jsonl)) {
    const label = cleanText(record[field], MAX_LABEL_CHARS);
    if (typeof record.id === 'string' && label) map.set(record.id, label);
  }
  return map;
}

/** Open tickets, in the cache script's order: status, then priority, then ticket number. */
export function parseZetahubRows(
  tasksJsonl: string,
  people: Map<string, string>,
  milestones: Map<string, string>,
  limit = MAX_ZETAHUB_ROWS
): Limited<ZetahubRow> {
  const records = [...jsonLines(tasksJsonl)];
  const parentKeys = keysById(records);
  const open: Array<ZetahubRow & { number: number }> = [];
  for (const r of records) {
    if (typeof r.status !== 'string' || CLOSED_STATUSES.has(r.status)) continue;
    const key = cleanText(r.key, MAX_LABEL_CHARS);
    const title = cleanText(r.title, MAX_TITLE_CHARS);
    const status = cleanText(r.status, MAX_LABEL_CHARS);
    if (!key || !title || !status) continue;
    const shown = displayTicketKey(key);
    open.push({
      key: shown,
      title,
      type: cleanText(r.type, MAX_LABEL_CHARS) ?? '',
      status,
      priority: cleanText(r.priority, MAX_LABEL_CHARS) ?? '',
      assignee: typeof r.assignee_id === 'string' ? people.get(r.assignee_id) ?? null : null,
      milestone: typeof r.milestone_id === 'string' ? milestones.get(r.milestone_id) ?? null : null,
      parentKey: typeof r.parent_task_id === 'string' ? parentKeys.get(r.parent_task_id) ?? null : null,
      updatedAt: cleanText(r.updated_at, MAX_TIME_CHARS),
      number: ticketNumber(shown)
    });
  }
  open.sort((a, b) =>
    statusRank(a.status) - statusRank(b.status)
    || priorityRank(a.priority) - priorityRank(b.priority)
    || a.number - b.number);
  return { items: open.slice(0, limit).map(({ number: _n, ...row }) => row), total: open.length };
}

/** Every ticket's id to its display key, closed ones included: a parent can be done while its child is open. */
function keysById(records: Array<Record<string, unknown>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    const key = cleanText(r.key, MAX_LABEL_CHARS);
    if (typeof r.id === 'string' && key) map.set(r.id, displayTicketKey(key));
  }
  return map;
}

/** Bullets under "## No ticket yet", up to the next heading. Indented lines continue a bullet. */
export function parseLocalItems(markdown: string, limit = MAX_LOCAL_ITEMS): Limited<LocalItem> {
  const bullets: string[] = [];
  let inSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      if (inSection) break;
      inSection = LOCAL_SECTION.test(line);
      continue;
    }
    if (!inSection) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) bullets.push(bullet[1]);
    else if (/^\s+\S/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  const items = bullets.map(toLocalItem).filter((i): i is LocalItem => i !== null);
  return { items: items.slice(0, limit), total: items.length };
}

function toLocalItem(raw: string): LocalItem | null {
  let text = raw.replace(/\s+/g, ' ').trim();
  const high = /^HIGH:\s*/.test(text);
  if (high) text = text.replace(/^HIGH:\s*/, '');
  const trailing = /\s*\(([^()]*)\)\s*$/.exec(text);
  const source = trailing ? cleanText(trailing[1], MAX_SOURCE_CHARS) : null;
  if (trailing) text = text.slice(0, trailing.index);
  const clean = cleanText(text, MAX_ITEM_CHARS);
  return clean ? { text: clean, source, high } : null;
}

function statusRank(status: string): number {
  if (status === 'In Progress') return 0;
  if (status === 'Waiting for review' || status === 'Ready for testing') return 1;
  if (status === 'To Do') return 2;
  return 3;
}

function priorityRank(priority: string): number {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, priority) ? PRIORITY_RANK[priority] : 4;
}

function ticketNumber(key: string): number {
  const match = /-(\d+)$/.exec(key);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
    } catch {
      // The sync writes whole lines; a broken one is skipped, not fatal.
    }
  }
}
