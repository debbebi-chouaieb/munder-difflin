// Claude Code session summaries for a project room (ADR 0005). Pure: callers pass
// the text they read from a transcript's head and tail, so the rules are testable
// without files.

import { cleanText } from './untrustedText';

/** Rooms list only the most recent sessions; older ones stay resumable by id. */
export const SESSION_LIST_LIMIT = 10;
/** Resuming above this context size asks first: the first prompt re-sends it all. */
export const LARGE_SESSION_TOKENS = 100_000;
/** With no usage record in the tail, a transcript this big is treated as large. */
export const LARGE_SESSION_FALLBACK_BYTES = 1024 * 1024;
/** Bytes read from the start of a transcript to find its first prompt. */
export const SESSION_HEAD_BYTES = 64 * 1024;
/** Bytes read from the end of a transcript to find its title and context size. */
export const SESSION_TAIL_BYTES = 256 * 1024;

const MAX_TITLE_CHARS = 120;
/** Claude Code session ids are UUIDs. Nothing else is listed or resumed, so no id can look like a flag. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionHead {
  firstPrompt: string | null;
  startedAt: string | null;
}

export interface SessionTail {
  /** A title set with /rename wins over the generated one. */
  customTitle: string | null;
  aiTitle: string | null;
  /** Context of the last assistant turn in the window; null when none is there. */
  contextTokens: number | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  startedAt: string | null;
  /** File modification time, in ms. */
  updatedAt: number;
  sizeBytes: number;
  contextTokens: number | null;
  large: boolean;
}

export interface SessionFileEntry {
  id: string;
  mtimeMs: number;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The session id of a transcript file name, or null for anything else in the folder. */
export function sessionIdFromFileName(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null;
  const id = name.slice(0, -'.jsonl'.length);
  return isValidSessionId(id) ? id : null;
}

/** Newest first, at most `limit`. Ties keep a stable order by id. */
export function pickRecentSessions<T extends SessionFileEntry>(entries: T[], limit = SESSION_LIST_LIMIT): T[] {
  return [...entries]
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit));
}

/**
 * The first prompt the person typed, skipping meta records, slash-command
 * wrappers (`<command-name>` and similar) and tool results. The last line of a
 * cut head is usually partial and simply fails to parse.
 */
export function parseSessionHead(text: string): SessionHead {
  let startedAt: string | null = null;
  for (const record of records(text)) {
    if (startedAt === null && typeof record.timestamp === 'string') startedAt = cleanText(record.timestamp, 40);
    if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) continue;
    const prompt = promptText(record.message);
    if (prompt) return { firstPrompt: prompt, startedAt };
  }
  return { firstPrompt: null, startedAt };
}

/**
 * Latest titles and context size in a transcript's tail. Claude Code rewrites
 * `ai-title` during a session. The context size is the last assistant turn's
 * input + cache + output tokens, the same sum as `readContextTokens`.
 */
export function parseSessionTail(text: string): SessionTail {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let contextTokens: number | null = null;
  for (const record of records(text)) {
    if (record.type === 'custom-title') customTitle = cleanTitle(record.customTitle ?? record.title) ?? customTitle;
    if (record.type === 'ai-title') aiTitle = cleanTitle(record.aiTitle) ?? aiTitle;
    if (record.type === 'assistant') contextTokens = usageTokens(record.message) ?? contextTokens;
  }
  return { customTitle, aiTitle, contextTokens };
}

/** Custom title, then generated title, then first prompt, then a short id. */
export function sessionTitle(id: string, head: SessionHead, tail: Pick<SessionTail, 'customTitle' | 'aiTitle'>): string {
  return tail.customTitle ?? tail.aiTitle ?? cleanTitle(head.firstPrompt) ?? fallbackTitle(id);
}

export function fallbackTitle(id: string): string {
  return `Session ${id.slice(0, 8)}`;
}

/** Fails closed: an unknown size on a big file still asks before resuming. */
export function isLargeSession(contextTokens: number | null, sizeBytes: number): boolean {
  if (contextTokens === null) return sizeBytes > LARGE_SESSION_FALLBACK_BYTES;
  return contextTokens > LARGE_SESSION_TOKENS;
}

type JsonRecord = Record<string, unknown> & { message?: unknown };

function* records(text: string): Generator<JsonRecord> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A head or tail window cuts its edge lines; those are expected to fail.
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as JsonRecord;
  }
}

function promptText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return realPrompt(content);
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = realPrompt((part as { text?: unknown }).text);
      if (text) return text;
    }
  }
  return null;
}

/** Text the harness injects starts with a tag (`<command-name>`, `<local-command-caveat>`). */
function realPrompt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && !text.startsWith('<') ? text : null;
}

function cleanTitle(value: unknown): string | null {
  return cleanText(value, MAX_TITLE_CHARS);
}

/**
 * Claude writes synthetic assistant records (`model: "<synthetic>"`) with all-zero
 * usage. A zero sum says nothing about the context, so it is not a reading; the
 * previous real turn, or the size fallback, decides instead.
 */
function usageTokens(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const sum = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  return sum > 0 ? sum : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
