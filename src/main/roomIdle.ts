// Idle shutdown of room lead terminals, owned by main (ADR 0005, amended 2026-11-23).
// A lead stops when no window shows its terminal and it has had neither output nor
// input for `roomIdleMinutes`. The stop re-checks that right before the kill, so a
// keystroke or a window showing it in between keeps the lead alive.

export interface LiveLead {
  id: string;
  /** Epoch ms of the PTY's last output (main's own clock, not batched). */
  lastOutputAt: number;
}

export interface RoomIdleDeps {
  /** Minutes from config, already clamped; 0 turns idle shutdown off. */
  idleMinutes: () => number;
  liveLeads: () => LiveLead[];
  isShown: (agentId: string) => boolean;
  /** Epoch ms of the last input, open, show or hide of the lead's terminal; 0 when never. */
  lastUsed: (agentId: string) => number;
  /** Stops the lead through the room's own close path; `stillIdle` is checked right before the kill. */
  stop: (agentId: string, stillIdle: () => boolean) => Promise<boolean>;
  now?: () => number;
  log: (line: string) => void;
}

export interface RoomIdleSweeper {
  /** One pass; resolves to the leads it stopped. */
  sweep: () => Promise<string[]>;
  /** Runs `sweep` every `everyMs`; returns the stop function. */
  start: (everyMs: number) => () => void;
}

export function createRoomIdleSweeper(deps: RoomIdleDeps): RoomIdleSweeper {
  const now = deps.now ?? Date.now;
  let sweeping = false;

  const isIdle = (agentId: string, idleMs: number): boolean => {
    if (deps.isShown(agentId)) return false;
    const lead = deps.liveLeads().find((l) => l.id === agentId);
    if (!lead) return false;
    return now() - Math.max(lead.lastOutputAt, deps.lastUsed(agentId)) >= idleMs;
  };

  const sweep = async (): Promise<string[]> => {
    const minutes = deps.idleMinutes();
    if (minutes <= 0 || sweeping) return [];
    sweeping = true;
    const idleMs = minutes * 60_000;
    const stopped: string[] = [];
    try {
      for (const lead of deps.liveLeads()) {
        if (!isIdle(lead.id, idleMs)) continue;
        try {
          if (await deps.stop(lead.id, () => isIdle(lead.id, idleMs))) {
            stopped.push(lead.id);
            deps.log(`[room] stopped idle lead ${lead.id} after ${minutes} min off screen and silent`);
          }
        } catch (e) {
          deps.log(`[room] idle stop of ${lead.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      sweeping = false;
    }
    return stopped;
  };

  return {
    sweep,
    start(everyMs) {
      const timer = setInterval(() => { void sweep(); }, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    }
  };
}
