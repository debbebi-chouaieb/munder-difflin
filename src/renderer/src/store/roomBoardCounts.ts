// Ticket counts for the two boards on a project room's wall (ADR 0005). Pure:
// the room panel store keeps them, the floor draws them.

import type { RoomTickets } from '@shared/ticketSources';

/** Counts per source; null when that source is not set up or cannot be read. */
export interface BoardCounts {
  zetahub: number | null;
  local: number | null;
}

export function boardCounts(tickets: RoomTickets): BoardCounts {
  return {
    zetahub: tickets.zetahub.ok ? tickets.zetahub.total : null,
    local: tickets.local.ok ? tickets.local.total : null
  };
}

export function sameBoardCounts(a: BoardCounts | undefined, b: BoardCounts | undefined): boolean {
  return a?.zetahub === b?.zetahub && a?.local === b?.local;
}
