// Stops room leads that are off screen and silent for `roomIdleMinutes` (ADR 0005).
// Checks once a minute from main's PTY list; stops through room:closeTerminal, so
// main kills and archives the lead the same way the room's Stop button does.

import { useEffect } from 'react';
import { roomIdleMinutes } from '@shared/roomLimits';
import { disposeTerminal, isTerminalOnScreen } from '@/components/terminalPool';
import { idleLeadsToStop } from '@/components/room/roomIdle';
import { useProjects } from '@/store/projects';

const CHECK_EVERY_MS = 60_000;

export function useRoomIdleShutdown(configuredMinutes: number | undefined): void {
  const minutes = roomIdleMinutes(configuredMinutes);
  useEffect(() => {
    if (minutes === 0) return;
    let running = false;
    const check = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const ptys = await window.cth.listPtys();
        const stops = idleLeadsToStop(ptys, useProjects.getState().snapshot.projects, isTerminalOnScreen, Date.now(), minutes);
        for (const stop of stops) {
          const res = await window.cth.roomCloseTerminal(stop.projectId);
          if (res.ok) {
            // Same as Stop: the next open of this lead must not reuse the old screen.
            disposeTerminal(stop.ptyId);
            console.info(`[room] stopped the idle lead of ${stop.projectId} after ${minutes} min`);
          } else {
            console.warn(`[room] idle stop of ${stop.projectId} failed: ${res.error}`);
          }
        }
      } catch (e) {
        console.warn(`[room] idle check failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => { void check(); }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [minutes]);
}
