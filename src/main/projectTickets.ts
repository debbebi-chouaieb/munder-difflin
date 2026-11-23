// Reads the two task tables of a project room (ADR 0005) from disk:
// the zetahub-sync cache under ~/.claude, and the project's local open-work file.
// Every path is built here from the project record; nothing comes from the renderer.

import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLocalAbsolute, isNetworkPath, isWithinRoots } from './rootGuard';
import { cleanText } from '../shared/untrustedText';
import { zetahubShown, type Project } from '../shared/project';
import {
  cacheFileStem,
  parseLabelMap,
  parseLocalItems,
  parseZetahubRows,
  type LocalTable,
  type RoomTickets,
  type ZetahubTable
} from '../shared/ticketSources';

/** Cache files are a few hundred KB; anything bigger is not a cache we wrote. */
const MAX_CACHE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LOCAL_FILE_BYTES = 1024 * 1024;

export type TicketProject = Pick<Project, 'path' | 'zetahubKey' | 'localWorkPath' | 'showZetahub'>;

type Log = (line: string) => void;

/** `$ZETAHUB_CACHE` when it is a local absolute folder, otherwise ~/.claude/cache/zetahub. */
export function zetahubCacheDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const fromEnv = env.ZETAHUB_CACHE;
  if (fromEnv && isLocalAbsolute(fromEnv)) return fromEnv;
  return path.join(home, '.claude', 'cache', 'zetahub');
}

export async function readRoomTickets(project: TicketProject, log: Log, cacheDir: string = zetahubCacheDir()): Promise<RoomTickets> {
  // A hidden section reads nothing, so its wall board shows no count either.
  const [zetahub, local] = await Promise.all([
    zetahubShown(project)
      ? readZetahubTable(project.zetahubKey, cacheDir, log)
      : Promise.resolve<ZetahubTable>({ ok: false, key: project.zetahubKey, reason: 'hidden' }),
    readLocalTable(project.path, project.localWorkPath, log)
  ]);
  return { zetahub, local };
}

export async function readZetahubTable(key: string | null, cacheDir: string, log: Log): Promise<ZetahubTable> {
  if (!key) return { ok: false, key: null, reason: 'no-key' };
  const meta = await readCacheFile(path.join(cacheDir, 'meta.json'), log);
  if (meta.state === 'missing') return { ok: false, key, reason: 'no-cache' };
  const stem = cacheFileStem(key);
  const tasks = await readCacheFile(path.join(cacheDir, 'tasks', `${stem}.jsonl`), log);
  if (tasks.state === 'missing') return { ok: false, key, reason: 'not-cached' };
  if (tasks.state !== 'ok') return { ok: false, key, reason: 'unreadable' };
  const [people, milestones] = await Promise.all([
    readCacheFile(path.join(cacheDir, 'people.jsonl'), log),
    readCacheFile(path.join(cacheDir, 'milestones', `${stem}.jsonl`), log)
  ]);
  const table = parseZetahubRows(
    tasks.text,
    parseLabelMap(people.state === 'ok' ? people.text : '', 'name'),
    parseLabelMap(milestones.state === 'ok' ? milestones.text : '', 'title')
  );
  return { ok: true, key, rows: table.items, total: table.total, syncedAt: syncedAt(meta) };
}

/**
 * The file is named by the repo's own CLAUDE.md, so it is untrusted: the path is
 * checked as text before any disk access, and every segment must be a real
 * folder or file. A link anywhere (which could point at a network share and leak
 * credentials on Windows) is refused without being followed.
 */
export async function readLocalTable(projectPath: string, rel: string | null, log: Log): Promise<LocalTable> {
  if (!rel) return { ok: false, reason: 'no-line' };
  if (path.isAbsolute(rel) || isNetworkPath(rel)) return { ok: false, reason: 'unavailable' };
  const target = path.resolve(projectPath, rel);
  if (target === path.resolve(projectPath) || !isWithinRoots(target, [projectPath])) return { ok: false, reason: 'unavailable' };
  const segments = path.relative(projectPath, target).split(path.sep);
  let current = projectPath;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let info;
    try {
      info = await lstat(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`[room] local work path check failed: ${errText(e)}`);
      return { ok: false, reason: 'unavailable' };
    }
    const last = i === segments.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return { ok: false, reason: 'unavailable' };
  }
  let text: string;
  let file: FileHandle | undefined;
  try {
    // A link swapped in after the walk: O_NOFOLLOW refuses it where the OS has
    // it, and the handle is checked before a byte is read, so nothing outside the
    // project is ever read. Windows has no O_NOFOLLOW, so the open itself may
    // still touch a swapped-in share; the walk above keeps that window short.
    file = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile()) return { ok: false, reason: 'unavailable' };
    if (info.size > MAX_LOCAL_FILE_BYTES) return { ok: false, reason: 'unreadable' };
    if (!isWithinRoots(await realpath(target), [await realpath(projectPath)])) return { ok: false, reason: 'unavailable' };
    text = await file.readFile('utf8');
  } catch (e) {
    log(`[room] local work file read failed: ${errText(e)}`);
    return { ok: false, reason: 'unreadable' };
  } finally {
    await file?.close().catch((e: unknown) => log(`[room] local work file close failed: ${errText(e)}`));
  }
  const table = parseLocalItems(text);
  return { ok: true, path: cleanText(rel.replace(/\\/g, '/'), 200) ?? '', items: table.items, total: table.total };
}

type ReadResult = { state: 'ok'; text: string } | { state: 'missing' } | { state: 'too-big' } | { state: 'error' };

/** The cache folder is the user's own (or `$ZETAHUB_CACHE`), so links there are followed. */
async function readCacheFile(file: string, log: Log): Promise<ReadResult> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return { state: 'missing' };
    if (st.size > MAX_CACHE_FILE_BYTES) {
      log(`[room] cache file too big, skipped: ${path.basename(file)}`);
      return { state: 'too-big' };
    }
    return { state: 'ok', text: await readFile(file, 'utf8') };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    log(`[room] cache read failed for ${path.basename(file)}: ${errText(e)}`);
    return { state: 'error' };
  }
}

function syncedAt(meta: ReadResult): string | null {
  if (meta.state !== 'ok') return null;
  try {
    const value = (JSON.parse(meta.text) as { synced_at?: unknown }).synced_at;
    return cleanText(value, 40);
  } catch {
    return null;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
