// Claude Code's own folder trust (ADR 0005). Pure: callers pass the parsed
// ~/.claude.json. Claude keys projects by forward-slash path and treats a trusted
// parent as trusting its children, so "open without trust" only asks when neither
// the folder nor a parent is already accepted.

/** True when `cwd` or one of its parents has `hasTrustDialogAccepted: true`. */
export function claudeTrustCovers(claudeConfig: unknown, cwd: string, caseInsensitive: boolean): boolean {
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
    if (base && (target === base || target.startsWith(`${base}/`))) return true;
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
 * not type into them: the prompt's default answer is "yes". The first hook event
 * that proves a turn ran releases the agent; so does its terminal closing.
 */
export class TrustPromptGate {
  private readonly waiting = new Set<string>();

  hold(agentId: string): void {
    this.waiting.add(agentId);
  }

  /** A hook event or the person typing releases the agent. */
  release(agentId: string): void {
    this.waiting.delete(agentId);
  }

  blocks(agentId: string): boolean {
    return this.waiting.has(agentId);
  }
}
