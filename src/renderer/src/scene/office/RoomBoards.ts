import type { Graphics } from 'pixi.js';
import type { FloorRoom } from './roomLayout';
import type { BoardCounts } from '@/store/roomBoardCounts';
import { countNotes, drawCork, roomBoardsOrigin, roomContains, SECOND_CORK_X } from './corkBoard';

/** The part of the room panel store the boards read. */
export interface BoardCountsSource {
  getState: () => { counts: Record<string, BoardCounts> };
  subscribe: (listener: (state: { counts: Record<string, BoardCounts> }, prev: { counts: Record<string, BoardCounts> }) => void) => () => void;
}

export interface RoomBoardsOptions {
  rooms: readonly FloorRoom[];
  tileSize: number;
  /** Note and header colors of the two boards. */
  colors: { zetahub: number; local: number };
  /** A new Pixi Graphics; injected so the boards can be tested without a GPU. */
  makeGraphics: () => Graphics;
  /** Adds to the character layer, which sorts by zIndex. */
  addChild: (g: Graphics) => void;
  onPick: (roomId: string) => void;
  counts: BoardCountsSource;
}

/**
 * Project rooms on the floor (ADR 0005): a click target under the characters,
 * so clicking an agent still selects the agent while a click on the room's
 * floor or boards picks the room; and two cork boards on the room's top wall,
 * open ZetaHub tickets on the left and local items on the right. Redraws only
 * when a count changes. The scene owns the graphics; `destroy` unsubscribes.
 */
export class RoomBoards {
  private readonly boards = new Map<string, Graphics>();
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: RoomBoardsOptions) {
    const ts = opts.tileSize;
    for (const room of opts.rooms) {
      if (room.kind !== 'project') continue;
      const pick = (ev: { stopPropagation: () => void }): void => {
        ev.stopPropagation();
        opts.onPick(room.id);
      };
      const hit = opts.makeGraphics();
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.hitArea = { contains: (x: number, y: number) => roomContains(room.rect, ts, x, y) };
      hit.zIndex = -1;
      hit.on('pointertap', pick);
      opts.addChild(hit);

      const boards = opts.makeGraphics();
      boards.eventMode = 'static';
      boards.cursor = 'pointer';
      const origin = roomBoardsOrigin(room.rect, ts);
      boards.position.set(origin.x, origin.y);
      boards.zIndex = room.rect.y * ts;
      boards.on('pointertap', pick);
      opts.addChild(boards);
      this.boards.set(room.id, boards);
    }
    this.draw(opts.counts.getState().counts);
    // setCounts keeps the same object when nothing changed, so this is a real change.
    this.unsubscribe = opts.counts.subscribe((s, prev) => {
      if (s.counts !== prev.counts) this.draw(s.counts);
    });
  }

  destroy(): void {
    this.unsubscribe();
  }

  private draw(counts: Record<string, BoardCounts>): void {
    const { zetahub, local } = this.opts.colors;
    for (const [roomId, g] of this.boards) {
      const c = counts[roomId];
      g.clear();
      drawCork(g, 0, zetahub, countNotes(c?.zetahub ?? null, zetahub));
      drawCork(g, SECOND_CORK_X, local, countNotes(c?.local ?? null, local));
    }
  }
}
