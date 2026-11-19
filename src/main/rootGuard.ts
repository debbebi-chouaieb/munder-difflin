/**
 * Which folders the renderer may browse, read, write or run git in.
 *
 * The fs:* and git:* IPC handlers take a root from the renderer, which also
 * renders agent output, so it is treated as less trusted. A root is allowed only
 * when its real path is (or sits inside) the real path of a folder main already
 * knows: the workspace, an agent's working folder or worktree, the hive home, or
 * a registered repo. Network paths are always refused: touching \\server\share
 * makes Windows authenticate to that server with the user's credentials.
 *
 * Handlers must use the returned real path, not the path they were given, so the
 * root itself cannot be swapped for a junction between the check and the use.
 * Links below the root are a separate concern, handled by safeResolve (fs.ts)
 * for file reads and writes.
 *
 * Mapped drive letters (Z: pointing at a share) pass the network check on the
 * raw path; the fs and git handlers still refuse them, because realpath turns
 * them into \\server\share. A drive the user mapped themselves is accepted risk.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** True for `\\server\share`, `//server/share` and the `\\?\` / `\\.\` forms. */
export function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** Absolute, local and not a device path: the only paths worth touching. */
export function isLocalAbsolute(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && isAbsolute(p) && !isNetworkPath(p);
}

/** resolve() drops trailing separators except on a drive or filesystem root. */
function normalize(p: string, caseInsensitive: boolean): string {
  const abs = resolve(p);
  return caseInsensitive ? abs.toLowerCase() : abs;
}

/** Pure path check: `candidate` equals one of `roots` or is inside it. */
export function isWithinRoots(candidate: string, roots: ReadonlyArray<string>, caseInsensitive = process.platform === 'win32'): boolean {
  if (!isLocalAbsolute(candidate)) return false;
  const target = normalize(candidate, caseInsensitive);
  return roots.some((root) => {
    if (!isLocalAbsolute(root)) return false;
    const base = normalize(root, caseInsensitive);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

async function realOrNull(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

/** Real paths of the known roots change rarely; resolving them on every IPC
 *  call is wasteful, and a disconnected mapped drive would stall each call. */
const ROOT_CACHE_MS = 15_000;
const rootCache = new Map<string, { real: string | null; at: number }>();

async function cachedReal(p: string, now = Date.now()): Promise<string | null> {
  const hit = rootCache.get(p);
  if (hit && now - hit.at < ROOT_CACHE_MS) return hit.real;
  const real = await realOrNull(p);
  rootCache.set(p, { real, at: now });
  return real;
}

/**
 * The candidate's real path when it lies inside a known folder, else null.
 * Comparing real paths makes short (8.3) and long names of one folder match,
 * and refuses a link inside a known folder that points outside it. A root that
 * does not exist is refused: every fs and git operation needs it to.
 */
export async function resolveAllowedRoot(candidate: unknown, roots: ReadonlyArray<string>): Promise<string | null> {
  if (!isLocalAbsolute(candidate)) return null;
  const real = await realOrNull(candidate);
  if (!real || isNetworkPath(real)) return null;
  const unique = [...new Set(roots.filter(isLocalAbsolute))];
  const realRoots = (await Promise.all(unique.map((r) => cachedReal(r))))
    .filter((r): r is string => !!r && !isNetworkPath(r));
  return isWithinRoots(real, realRoots) ? real : null;
}

/** An agent terminal is busy when it printed output this recently. */
export const BUSY_WINDOW_MS = 10_000;

/**
 * The first busy terminal working inside `realRoot` (a real path from
 * resolveAllowedRoot). Terminal folders are resolved too, so `D:/repo` from git,
 * `d:\Repo` and an 8.3 form all match the same folder.
 */
export async function busyTerminalIn<T extends { cwd: string; lastOutputAt: number }>(
  terminals: ReadonlyArray<T>,
  realRoot: string,
  now = Date.now(),
  resolveReal: (p: string) => Promise<string | null> = realOrNull
): Promise<T | undefined> {
  for (const terminal of terminals) {
    if (now - terminal.lastOutputAt >= BUSY_WINDOW_MS) continue;
    const real = (await resolveReal(terminal.cwd)) ?? terminal.cwd;
    if (isWithinRoots(real, [realRoot])) return terminal;
  }
  return undefined;
}

export const ROOT_REFUSED = 'folder not allowed';
