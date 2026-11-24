import { randomBytes, timingSafeEqual } from 'crypto';

/** How a hook event's token compares with the one main issued for its agent (ADR 0010). */
export type SpawnTokenCheck = 'ok' | 'rejected' | 'unissued';

/**
 * The hook token of each agent's latest spawn. A token stays on record after its
 * terminal closes, until the next spawn of that agent id replaces it, so a forged
 * event for a stopped agent is still refused. Kept in main's memory only.
 */
export class SpawnTokens {
  private readonly current = new Map<string, string>();

  constructor(private readonly mint: () => string = () => randomBytes(32).toString('hex')) {}

  /** A fresh token for a spawn about to start; record it with `issue` once it did. */
  next(): string {
    return this.mint();
  }

  issue(agentId: string, token: string): void {
    this.current.set(agentId, token);
  }

  check(agentId: string, token: unknown): SpawnTokenCheck {
    const expected = this.current.get(agentId);
    if (expected === undefined) return 'unissued';
    return typeof token === 'string' && sameToken(expected, token) ? 'ok' : 'rejected';
  }
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
