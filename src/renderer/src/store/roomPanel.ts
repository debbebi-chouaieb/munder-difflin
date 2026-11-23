/**
 * Which project room the right panel shows, and the ticket counts its wall
 * boards draw (ADR 0005, ADR 0006). Exclusive with the agent panel: selecting a
 * room shows the room; selecting an agent (agent store `select`) clears it. The
 * agent selection itself is kept, so closing the room returns to that agent.
 * A new agent (Add Agent, a hive spawn, the room's own lead) leaves the room open.
 */
import { create } from 'zustand';
import { boardCounts, sameBoardCounts, type BoardCounts } from './roomBoardCounts';

export interface RoomPanelState {
  selectedRoomId: string | null;
  selectRoom: (projectId: string) => void;
  clearRoom: () => void;
  /** Per project id; absent until the first read. */
  counts: Record<string, BoardCounts>;
  /** Stores a project's counts; keeps the same object when nothing changed, so the floor does not redraw. */
  setCounts: (projectId: string, counts: BoardCounts) => void;
  /**
   * Reads ticket counts for these projects in parallel. Failures keep the old
   * count and are logged. Counts of projects not listed are dropped, and an
   * older refresh that finishes late never overwrites a newer one.
   */
  refreshCounts: (projectIds: readonly string[]) => Promise<void>;
  /**
   * Height in px of the room's sessions and tasks above a running lead terminal;
   * null: the default split. 0 hides them. Shared by every room, kept for the
   * app session only.
   */
  topHeight: number | null;
  setTopHeight: (px: number | null) => void;
  /** Last height the lists were open at, restored by a show; null: the default split. */
  lastOpenTopHeight: number | null;
  /** Hides the lists (remembering `shownHeight`) or shows them at the last open height. */
  toggleLists: (shownHeight: number) => void;
}

export const useRoomPanel = create<RoomPanelState>((set, get) => ({
  selectedRoomId: null,
  selectRoom: (projectId) => set({ selectedRoomId: projectId }),
  clearRoom: () => { if (get().selectedRoomId !== null) set({ selectedRoomId: null }); },
  topHeight: null,
  setTopHeight: (topHeight) => set(topHeight !== null && topHeight > 0 ? { topHeight, lastOpenTopHeight: topHeight } : { topHeight }),
  lastOpenTopHeight: null,
  toggleLists: (shownHeight) => set(shownHeight > 0
    ? { topHeight: 0, lastOpenTopHeight: shownHeight }
    : { topHeight: get().lastOpenTopHeight }),
  counts: {},
  setCounts: (projectId, counts) => {
    if (!sameBoardCounts(get().counts[projectId], counts)) set((s) => ({ counts: { ...s.counts, [projectId]: counts } }));
  },
  refreshCounts: async (projectIds) => {
    const generation = ++countsGeneration;
    const listed = new Set(projectIds);
    const kept = Object.fromEntries(Object.entries(get().counts).filter(([id]) => listed.has(id)));
    if (Object.keys(kept).length !== Object.keys(get().counts).length) set({ counts: kept });
    await Promise.all(projectIds.map(async (id) => {
      try {
        const res = await window.cth.roomTickets(id);
        if (generation !== countsGeneration) return;
        if (res.ok) get().setCounts(id, boardCounts(res.tickets));
        else console.warn(`[room] ticket counts for ${id}: ${res.error}`);
      } catch (e) {
        console.warn(`[room] ticket counts for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }
}));

/** Bumped by each refreshCounts; a refresh whose answers come back after a newer one started drops them. */
let countsGeneration = 0;
