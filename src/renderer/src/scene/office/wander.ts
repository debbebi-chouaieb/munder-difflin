/**
 * Where an idle avatar strolls next. Pure, so it is unit-testable.
 */

export interface WanderTile { x: number; y: number; }
export interface WanderBounds { x: number; y: number; width: number; height: number; }

const NEARBY_RANGE = 6;
const NEARBY_ATTEMPTS = 14;
const RETURN_ATTEMPTS = 40;

function inside(t: WanderTile, b: WanderBounds): boolean {
  return t.x >= b.x && t.y >= b.y && t.x < b.x + b.width && t.y < b.y + b.height;
}

/**
 * A nearby walkable tile, as on the hand-made floors. With bounds (the agent's
 * room on the Projects floor) the tile must be inside them, and an agent that is
 * outside (just arrived, back from the café) heads to any walkable tile in the
 * room instead of standing still. Null when nothing suitable was found.
 */
export function pickWanderTarget(
  cur: WanderTile,
  bounds: WanderBounds | undefined,
  isWalkable: (x: number, y: number) => boolean,
  random: () => number = Math.random
): WanderTile | null {
  if (bounds && !inside(cur, bounds)) {
    for (let attempt = 0; attempt < RETURN_ATTEMPTS; attempt++) {
      const t = { x: bounds.x + Math.floor(random() * bounds.width), y: bounds.y + Math.floor(random() * bounds.height) };
      if (isWalkable(t.x, t.y)) return t;
    }
    return null;
  }
  // Sample from the nearby square, clipped to the room when bounded, so a small
  // room does not waste every attempt on tiles outside it.
  const minX = bounds ? Math.max(bounds.x, cur.x - NEARBY_RANGE) : cur.x - NEARBY_RANGE;
  const maxX = bounds ? Math.min(bounds.x + bounds.width - 1, cur.x + NEARBY_RANGE - 1) : cur.x + NEARBY_RANGE - 1;
  const minY = bounds ? Math.max(bounds.y, cur.y - NEARBY_RANGE) : cur.y - NEARBY_RANGE;
  const maxY = bounds ? Math.min(bounds.y + bounds.height - 1, cur.y + NEARBY_RANGE - 1) : cur.y + NEARBY_RANGE - 1;
  for (let attempt = 0; attempt < NEARBY_ATTEMPTS; attempt++) {
    const t = {
      x: minX + Math.floor(random() * (maxX - minX + 1)),
      y: minY + Math.floor(random() * (maxY - minY + 1))
    };
    if ((t.x !== cur.x || t.y !== cur.y) && isWalkable(t.x, t.y)) return t;
  }
  return null;
}
