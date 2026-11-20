// Lists a project's recent Claude Code sessions for its room (ADR 0005).
// Reads only a head and a tail window of each transcript, re-reads a file only when
// its mtime or size changed, and never blocks the main thread.

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  fallbackTitle,
  isLargeSession,
  isValidSessionId,
  parseSessionHead,
  parseSessionTail,
  pickRecentSessions,
  SESSION_HEAD_BYTES,
  SESSION_TAIL_BYTES,
  sessionIdFromFileName,
  sessionTitle,
  type SessionFileEntry,
  type SessionSummary
} from '../shared/sessionList';
import { mapLimit } from '../shared/mapLimit';

export interface SessionListerDeps {
  /** Transcript folder for a project path (`projectDir` in production). */
  dirFor: (projectPath: string) => string;
  log: (line: string) => void;
  /** Summaries kept across calls; tests lower it to check eviction. */
  maxCacheEntries?: number;
  /** A list call this recent is reused, so room open and window focus share one read. */
  reuseMs?: number;
  now?: () => number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

type FileEntry = SessionFileEntry & { size: number };

/** A folder with more transcripts than this is not listed: stat-ing them all would stall the room. */
const MAX_SCANNED_FILES = 5000;
const STAT_CONCURRENCY = 16;

export class SessionLister {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly recent = new Map<string, { at: number; result: Promise<SessionSummary[]> }>();
  private readonly maxEntries: number;
  private readonly reuseMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: SessionListerDeps) {
    this.maxEntries = deps.maxCacheEntries ?? 256;
    this.reuseMs = deps.reuseMs ?? 2000;
    this.now = deps.now ?? Date.now;
  }

  /** The project's most recent sessions, newest first. A missing folder means none yet. */
  list(projectPath: string): Promise<SessionSummary[]> {
    const key = path.resolve(projectPath);
    const hit = this.recent.get(key);
    if (hit && this.now() - hit.at < this.reuseMs) return hit.result;
    const result = this.read(projectPath);
    this.recent.set(key, { at: this.now(), result });
    // A failed read must not be reused.
    result.catch(() => this.recent.delete(key));
    return result;
  }

  /** Summary of one of the project's sessions, or null when it is not there. */
  async summaryOf(projectPath: string, sessionId: string): Promise<SessionSummary | null> {
    if (!isValidSessionId(sessionId)) return null;
    const file = path.join(this.deps.dirFor(projectPath), `${sessionId}.jsonl`);
    let st;
    try {
      st = await stat(file);
    } catch {
      return null;
    }
    return st.isFile() ? this.summary(file, sessionId, st.mtimeMs, st.size) : null;
  }

  private async read(projectPath: string): Promise<SessionSummary[]> {
    const dir = this.deps.dirFor(projectPath);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const ids = names.map(sessionIdFromFileName).filter((id): id is string => id !== null);
    if (ids.length > MAX_SCANNED_FILES) {
      // Any subset could miss the newest sessions, so say so instead of listing a wrong "most recent".
      this.deps.log(`[room] ${ids.length} transcripts in ${dir}; over ${MAX_SCANNED_FILES}, not listed`);
      throw new Error('too many transcripts');
    }
    const stats = await mapLimit(ids, STAT_CONCURRENCY, async (id): Promise<FileEntry | null> => {
      try {
        const st = await stat(path.join(dir, `${id}.jsonl`));
        return st.isFile() ? { id, mtimeMs: st.mtimeMs, size: st.size } : null;
      } catch {
        // Removed between readdir and stat: it is simply not listed.
        return null;
      }
    });
    const recent = pickRecentSessions(stats.filter((e): e is FileEntry => e !== null));
    return Promise.all(recent.map((e) => this.summary(path.join(dir, `${e.id}.jsonl`), e.id, e.mtimeMs, e.size)));
  }

  private async summary(file: string, id: string, mtimeMs: number, size: number): Promise<SessionSummary> {
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      this.touch(file, hit);
      return hit.summary;
    }
    let summary: SessionSummary;
    try {
      const [headText, tailText] = await readHeadAndTail(file, size);
      const head = parseSessionHead(headText);
      const tail = parseSessionTail(tailText);
      summary = {
        id, title: sessionTitle(id, head, tail), startedAt: head.startedAt, updatedAt: mtimeMs,
        sizeBytes: size, contextTokens: tail.contextTokens, large: isLargeSession(tail.contextTokens, size)
      };
    } catch (e) {
      // One unreadable transcript keeps its row; it is not cached, so the next call retries.
      this.deps.log(`[room] could not read session ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return {
        id, title: fallbackTitle(id), startedAt: null, updatedAt: mtimeMs,
        sizeBytes: size, contextTokens: null, large: isLargeSession(null, size)
      };
    }
    this.touch(file, { mtimeMs, size, summary });
    return summary;
  }

  /** Least recently used goes first: re-insert on every use, drop the oldest key past the cap. */
  private touch(file: string, entry: CacheEntry): void {
    this.cache.delete(file);
    this.cache.set(file, entry);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
  }
}

async function readHeadAndTail(file: string, size: number): Promise<[string, string]> {
  const handle = await open(file, 'r');
  try {
    const head = await readWindow(handle, 0, Math.min(size, SESSION_HEAD_BYTES));
    const tailLen = Math.min(size, SESSION_TAIL_BYTES);
    const tail = await readWindow(handle, size - tailLen, tailLen);
    return [head, tail];
  } finally {
    await handle.close();
  }
}

async function readWindow(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}
