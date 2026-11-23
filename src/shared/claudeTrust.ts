// Claude Code's own folder trust (ADR 0005). Pure: callers pass the parsed
// ~/.claude.json. Claude keys projects by forward-slash path and treats a trusted
// parent as trusting its children, so "open without trust" only asks when neither
// the folder nor a parent is already accepted.

/** True when `cwd` or one of its parents has `hasTrustDialogAccepted: true`. */
export function claudeTrustCovers(claudeConfig: unknown, cwd: string, caseInsensitive: boolean): boolean {
  return anyTrustedKey(claudeConfig, cwd, caseInsensitive, (base, target) => target === base || target.startsWith(`${base}/`));
}

/** True when `cwd` itself (not only a parent) has `hasTrustDialogAccepted: true`. */
export function claudeTrustsExactly(claudeConfig: unknown, cwd: string, caseInsensitive: boolean): boolean {
  return anyTrustedKey(claudeConfig, cwd, caseInsensitive, (base, target) => target === base);
}

/**
 * Whether an untrusted lead may sit at a Claude startup prompt whose Enter means
 * yes, so automation must not type until a real turn ran (ADR 0005). Only one
 * case is known to show none: Claude trusts this exact folder and the folder has
 * no project MCP servers. Trust inherited from a parent still shows the
 * `.mcp.json` approval prompt (Claude Code issue reports, 2026); an unreadable
 * `.mcp.json` is passed as present by the caller: fail closed.
 */
export function trustPromptExpected(folder: { claudeTrustsExactly: boolean; hasProjectMcp: boolean }): boolean {
  return !folder.claudeTrustsExactly || folder.hasProjectMcp;
}

/**
 * True when `cwd` or any parent folder has a `.mcp.json` entry. Claude Code is
 * documented to read it from the project root; a published proof of concept
 * shows it also loads one from a parent, so every ancestor counts (fail closed).
 * `lstat` is used, never `stat`: a planted link to a network share must not be
 * followed (Windows would authenticate to it). Anything but "not found" counts
 * as present: a link, a folder, a permission error.
 */
export async function projectMcpConfigNear(
  cwd: string,
  lstat: (path: string) => Promise<unknown>,
  log: (line: string) => void
): Promise<boolean> {
  for (const candidate of mcpConfigCandidates(cwd)) {
    try {
      await lstat(candidate);
      return true;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'ENOENT') continue;
      log(`[room] could not check ${candidate}: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
  }
  return false;
}

/** `<dir>/.mcp.json` for `cwd` and each parent up to the root, nearest first; same separator as `cwd`. */
export function mcpConfigCandidates(cwd: string): string[] {
  const sep = cwd.includes('\\') ? '\\' : '/';
  const parts = cwd.split(/[\\/]+/);
  if (parts[parts.length - 1] === '') parts.pop();
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) out.push(`${parts.slice(0, n).join(sep)}${sep}.mcp.json`);
  return out;
}

function anyTrustedKey(
  claudeConfig: unknown,
  cwd: string,
  caseInsensitive: boolean,
  matches: (base: string, target: string) => boolean
): boolean {
  if (!claudeConfig || typeof claudeConfig !== 'object') return false;
  const projects = (claudeConfig as { projects?: unknown }).projects;
  if (!projects || typeof projects !== 'object') return false;
  const norm = (p: string): string => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  const target = norm(cwd);
  for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || (value as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted !== true) continue;
    const base = norm(key);
    if (base && matches(base, target)) return true;
  }
  return false;
}

/**
 * Hook events that prove Claude ran a real turn, so it is past its trust prompt.
 * `Status` ticks and `SessionStart` are not counted: whether they can fire before
 * the prompt is answered is not verified, and a wrong guess would let automation
 * press Enter on "yes".
 */
const TURN_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

export function hookProvesTurn(event: string | undefined): boolean {
  return event !== undefined && TURN_EVENTS.has(event);
}

/**
 * Agents whose terminal may be sitting at Claude's trust prompt. Automation must
 * not type into them: the prompt's default answer is "yes". A hook event that
 * proves a turn ran releases the agent only when it carries the token of the
 * current spawn (ADR 0008), so a late hook from a killed lead or a forged payload
 * cannot. The terminal of that same spawn closing releases it too.
 */
export class TrustPromptGate {
  private readonly waiting = new Map<string, string>();

  hold(agentId: string, spawnToken: string): void {
    this.waiting.set(agentId, spawnToken);
  }

  /** A turn from the current spawn releases the agent. Returns whether it did. */
  releaseOnTurn(agentId: string, spawnToken: unknown): boolean {
    const expected = this.waiting.get(agentId);
    if (expected === undefined || typeof spawnToken !== 'string' || !sameSecret(expected, spawnToken)) return false;
    this.waiting.delete(agentId);
    return true;
  }

  /** The terminal of the spawn holding `spawnToken` closed. */
  release(agentId: string, spawnToken: string): void {
    const expected = this.waiting.get(agentId);
    if (expected !== undefined && sameSecret(expected, spawnToken)) this.waiting.delete(agentId);
  }

  blocks(agentId: string): boolean {
    return this.waiting.has(agentId);
  }
}

/** Constant-time string comparison; this module stays free of Node imports. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
