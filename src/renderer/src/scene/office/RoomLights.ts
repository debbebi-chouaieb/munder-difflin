import { Container, Graphics, Text } from 'pixi.js';
import type { FloorRoom } from './roomLayout';

/** Above every character: the character layer sorts by y in pixels. */
export const ROOM_LIGHTS_Z = 1e7;

/** Seconds for the lights to reach their target. */
const FADE_SECONDS = 0.6;

interface RoomOverlay {
  room: FloorRoom;
  shade: Graphics;
  current: number;
  target: number;
}

/**
 * One dark overlay per room, eased toward a target darkness, plus the room's
 * name painted on its top wall. Sits above the characters so a dark room reads
 * as lights off, and ignores the pointer so agents stay clickable.
 */
export class RoomLights {
  readonly container = new Container();
  private overlays = new Map<string, RoomOverlay>();

  constructor(rooms: FloorRoom[], tileSize: number, zIndex: number) {
    this.container.eventMode = 'none';
    this.container.zIndex = zIndex;
    for (const room of rooms) {
      const shade = new Graphics();
      shade.rect(room.rect.x * tileSize, room.rect.y * tileSize, room.rect.width * tileSize, room.rect.height * tileSize).fill(0x0b0a14);
      shade.alpha = 0;
      this.container.addChild(shade);
      this.overlays.set(room.id, { room, shade, current: 0, target: 0 });

      const label = new Text({
        text: room.label,
        style: { fontFamily: 'monospace', fontSize: 9, fill: 0xf2ead8, fontWeight: 'bold' }
      });
      label.position.set(room.labelTile.x * tileSize + 2, room.labelTile.y * tileSize + 3);
      label.resolution = 2;
      this.container.addChild(label);
    }
  }

  setTarget(roomId: string, darkness: number): void {
    const overlay = this.overlays.get(roomId);
    if (overlay) overlay.target = darkness;
  }

  update(dt: number): void {
    const step = dt / FADE_SECONDS;
    for (const overlay of this.overlays.values()) {
      if (overlay.current === overlay.target) continue;
      const delta = overlay.target - overlay.current;
      overlay.current = Math.abs(delta) <= step ? overlay.target : overlay.current + Math.sign(delta) * step;
      overlay.shade.alpha = overlay.current;
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.overlays.clear();
  }
}
