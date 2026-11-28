// One holder per room lead at a time (ADR 0017): the room open, a pty spawn of
// the lead, and Forget trust must not overlap, or a spawn can pre-accept Claude's
// folder trust while the forget rewrites ~/.claude.json.

import { leadIdOfSpawn } from '../shared/roomLead';

export type LeadLockHolder = 'open' | 'spawn' | 'forget';

export interface LeadLock {
  /** Who holds this lead now, or null. */
  holder: (leadId: string) => LeadLockHolder | null;
  /** Runs `work` holding the lead, freed when it settles; null, and nothing run, when the lead is held. */
  run: <T>(leadId: string, holder: LeadLockHolder, work: () => Promise<T>) => Promise<T> | null;
}

export function createLeadLock(): LeadLock {
  const held = new Map<string, LeadLockHolder>();
  return {
    holder: (leadId) => held.get(leadId) ?? null,
    run(leadId, holder, work) {
      if (held.has(leadId)) return null;
      held.set(leadId, holder);
      // Started inside a promise so a synchronous throw also frees the lead.
      return Promise.resolve().then(work).finally(() => held.delete(leadId));
    }
  };
}

export const LEAD_SPAWN_REFUSED = 'a room lead starts from its room (room:openTerminal or room:restartLead)';

/**
 * The doors that take spawn options from outside main (`pty:spawn`, `spawnAgent`):
 * a lead id is refused (ADR 0019), anything else runs as is. Malformed lead ids are
 * refused too, so no half-lead id reaches the spawn core.
 */
export function spawnUnlessLead<R extends { ok: boolean; error?: string }>(
  ids: { id: string; hiveId: string | undefined },
  spawn: () => Promise<R>
): Promise<R | { ok: false; error: string }> {
  const lead = leadIdOfSpawn(ids.id, ids.hiveId);
  if (!lead.ok) return Promise.resolve({ ok: false, error: lead.error });
  if (lead.leadId) return Promise.resolve({ ok: false, error: LEAD_SPAWN_REFUSED });
  return spawn();
}

export const LEAD_BUSY_ERROR = 'room lead busy: it is being opened, started or its trust forgotten; try again';

/**
 * Main's own replays (the install relaunch): a lead spawn runs under a `spawn` hold,
 * any other spawn runs as is. Malformed lead ids are left to the spawn core, which refuses them.
 */
export function spawnUnderLeadLock<R extends { ok: boolean; error?: string }>(
  lock: LeadLock,
  ids: { id: string; hiveId: string | undefined },
  spawn: () => Promise<R>
): Promise<R | { ok: false; error: string }> {
  const lead = leadIdOfSpawn(ids.id, ids.hiveId);
  if (!lead.ok || !lead.leadId) return spawn();
  return lock.run(lead.leadId, 'spawn', spawn) ?? Promise.resolve({ ok: false, error: LEAD_BUSY_ERROR });
}
