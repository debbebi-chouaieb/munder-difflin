// Cork boards on the floor's walls: the office task boards and the two
// ticket-count boards in each project room (ADR 0005).

import type { Graphics } from 'pixi.js';

/** Notes a board shows before the rest becomes a corner pile. */
export const CORK_NOTES = 12;
const CORK_W = 30;
const CORK_GAP = 4;
/** Local x of the second of two boards side by side. */
export const SECOND_CORK_X = CORK_W + CORK_GAP;
/** Two boards side by side. */
export const ROOM_BOARDS_W = CORK_W * 2 + CORK_GAP;

/** One cork board with a colored header at local x `ox`; one note per color, overflow as a pile. */
export function drawCork(g: Graphics, ox: number, header: number, notes: readonly number[]): void {
  g.rect(ox, -8, CORK_W, 22).fill(0x6e5639);         // frame
  g.rect(ox + 1, -7, CORK_W - 2, 3).fill(header);    // header strip
  g.rect(ox + 1, -4, CORK_W - 2, 17).fill(0xc9b083); // cork
  const n = Math.min(notes.length, CORK_NOTES);
  for (let i = 0; i < n; i++) {
    const x = ox + 3 + (i % 4) * 7;
    const y = -2 + Math.floor(i / 4) * 5;
    g.rect(x, y, 5, 4).fill(notes[i]);
    g.rect(x + 2, y, 1, 1).fill(0x4a3b52);           // pin
  }
  if (notes.length > CORK_NOTES) {
    g.rect(ox + 22, 8, 5, 4).fill(0xe8e0c8);
    g.rect(ox + 23, 7, 5, 4).fill(0xf2eddc);
  }
}

/**
 * Notes for a count: one per item up to the visible limit, plus one more so the
 * overflow pile shows. null (source not set up) is an empty board.
 */
export function countNotes(count: number | null, color: number): number[] {
  if (count === null || count <= 0) return [];
  return new Array<number>(Math.min(count, CORK_NOTES + 1)).fill(color);
}

/**
 * Where a project room's two boards hang, in pixels: on the top wall (the row
 * above the interior, like the office boards), flush with the room's right
 * side, so the name painted at the left stays clear.
 */
export function roomBoardsOrigin(rect: { x: number; y: number; width: number }, tileSize: number): { x: number; y: number } {
  return { x: (rect.x + rect.width) * tileSize - ROOM_BOARDS_W - 4, y: (rect.y - 1) * tileSize };
}

/** True when the point (pixels) is inside the room's interior. */
export function roomContains(rect: { x: number; y: number; width: number; height: number }, tileSize: number, px: number, py: number): boolean {
  return px >= rect.x * tileSize && px < (rect.x + rect.width) * tileSize
    && py >= rect.y * tileSize && py < (rect.y + rect.height) * tileSize;
}
