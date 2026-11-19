/**
 * Runtime floor generator for the Projects floor (ADR 0002).
 *
 * Builds a Tiled map in memory: a top band with the CEO office, the tech-leads
 * room and the café, then one room per ticked project in bands of up to four,
 * each band above a corridor, all corridors joined by a spine on the right and
 * an entrance at the bottom. Walls, doors, the desk stamp and the reachability
 * check are ported from tools/gen-b99-map.cjs, so desks, monitors and cup spots
 * behave exactly as on the hand-made floors.
 *
 * Pure: no Pixi, no DOM. The output is the same TiledMap shape the theme loader
 * produces from a .tmj file.
 */
import type { TiledMap } from './TiledMapRenderer';

/** A tile coordinate. Declared here so this module has no runtime dependency. */
export interface Tile { x: number; y: number; }

export const TILE = 16;
const WALL_GID = 570;
const floorGid = (x: number, y: number): number =>
  (y % 2 === 0) ? (x % 2 === 0 ? 800 : 799) : (x % 2 === 0 ? 784 : 783);

/** Desk stamp relative to the seat: [layer, dx, dy, gid]. From office.tmj's pc desk. */
const DESK_STAMP: ReadonlyArray<readonly [LayerKey, number, number, number]> = [
  ['below', -1, -1, 2], ['below', 0, -1, 3], ['below', 1, -1, 4],
  ['below', 0, 0, 289], ['below', 0, 1, 305],
  ['above', 0, -2, 365], ['above', 1, -2, 366],
  ['above', 0, -1, 381], ['above', 1, -1, 382],
  ['above', -1, 0, 18], ['above', 0, 0, 19], ['above', 1, 0, 20],
  ['coll', 0, -2, 1], ['coll', 1, -2, 1],
  ['coll', -1, -1, 1], ['coll', 0, -1, 1], ['coll', 1, -1, 1],
  ['coll', -1, 0, 1], ['coll', 1, 0, 1],
];
type LayerKey = 'floor' | 'walls' | 'below' | 'above' | 'coll';

/** Room geometry, in tiles. A room is ROOM_W wide including both walls; rooms in
 *  a band share their side walls, so the stride is one less. */
const ROOM_W = 15;
const COL_STRIDE = ROOM_W - 1;
const DESKS_PER_ROW = 3;
const DESK_DX = 4;
const FIRST_DESK_X = 3;
const FIRST_DESK_Y = 4;
const DESK_ROW_STEP = 5;
const CORRIDOR_H = 3;
const SPINE_W = 3;
const MAX_COLS = 4;
/** The café needs this many rows for its tables, counter and machine. */
const CAFE_H = 14;

export type RoomKind = 'ceo' | 'techLeads' | 'cafe' | 'project';

export interface FloorRoomSpec {
  /** Project id, or 'ceo' / 'tech-leads' / 'cafe'. */
  id: string;
  kind: RoomKind;
  label: string;
  /** Desks to place (0 for the café). Rounded up to whole rows of three. */
  desks: number;
}

export interface FloorRoom {
  id: string;
  kind: RoomKind;
  label: string;
  /** Interior rectangle (inside the walls), in tiles. */
  rect: { x: number; y: number; width: number; height: number };
  /** Spawn-point names of this room's seats, in claim order. */
  seatNames: string[];
  /** Where the room's name is painted (top wall, left). */
  labelTile: Tile;
}

export interface ProjectFloor {
  map: TiledMap;
  rooms: FloorRoom[];
  /** Every desk in claim order: the CEO desk first. */
  seatNames: string[];
  cafeSeatNames: string[];
  cafeStands: ReadonlyArray<readonly [string, 'coffee' | 'vending']>;
  coffee: { trayTile: Tile; trayStand: Tile; machineStand: Tile; sinkTile: Tile; sinkStand: Tile };
  anchors: { calendar: Tile; boards: Tile; clock: Tile; askMe: Tile; machine: Tile };
  entrance: Tile;
}

/** Desk rows for `desks` seats; always at least one row. */
export function deskRows(desks: number): number {
  return Math.max(1, Math.ceil(Math.max(desks, 1) / DESKS_PER_ROW));
}

/** Total room height in tiles (with walls) for a number of desk rows. */
function roomHeight(rows: number): number {
  return FIRST_DESK_Y + DESK_ROW_STEP * (rows - 1) + 4;
}

/**
 * Desks a room should have for the agents in it: one free desk beyond the
 * agents present, rounded up to a whole row. Growing only by whole rows keeps
 * the floor from rebuilding on every spawn.
 */
export function desksFor(agentCount: number): number {
  return deskRows(agentCount + 1) * DESKS_PER_ROW;
}

/** Mutable tile layers of the floor being built. */
class Grid {
  readonly layers: Record<LayerKey, number[]>;
  constructor(readonly W: number, readonly H: number) {
    const mk = () => new Array<number>(W * H).fill(0);
    this.layers = { floor: mk(), walls: mk(), below: mk(), above: mk(), coll: mk() };
  }
  set(layer: LayerKey, x: number, y: number, gid: number): void {
    if (x >= 0 && y >= 0 && x < this.W && y < this.H) this.layers[layer][y * this.W + x] = gid;
  }
  wall(x: number, y: number): void { this.set('walls', x, y, WALL_GID); this.set('coll', x, y, 1); }
  open(x: number, y: number): void { this.set('walls', x, y, 0); this.set('coll', x, y, 0); this.set('floor', x, y, floorGid(x, y)); }
}

/** The top band is fixed: CEO office in column 0, tech leads in 1, café in 2. */
const CEO_ORIGIN: Tile = { x: 0, y: 0 };
const CAFE_ORIGIN: Tile = { x: 2 * COL_STRIDE, y: 0 };

type CafeLayout = Pick<ProjectFloor, 'cafeSeatNames' | 'cafeStands' | 'coffee'> & { spots: Array<{ name: string; tile: Tile }> };

/** Café spots, relative to the café's top-left wall corner (B99 break-room
 *  layout). The café has no furniture art: cups and the sink draw on the floor. */
function cafeLayout(o: Tile): CafeLayout {
  const at = (dx: number, dy: number): Tile => ({ x: o.x + dx, y: o.y + dy });
  return {
    spots: [
      { name: 'cafe-seat-1', tile: at(3, 5) }, { name: 'cafe-seat-2', tile: at(3, 7) },
      { name: 'cafe-seat-3', tile: at(8, 5) }, { name: 'cafe-seat-4', tile: at(8, 7) },
      { name: 'cafe-stand-coffee', tile: at(4, 11) }, { name: 'cafe-stand-vending', tile: at(10, 3) }
    ],
    cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
    cafeStands: [['cafe-stand-coffee', 'coffee'], ['cafe-stand-vending', 'vending']],
    coffee: { trayTile: at(10, 9), trayStand: at(10, 10), machineStand: at(4, 12), sinkTile: at(6, 9), sinkStand: at(6, 10) }
  };
}

/** Props on the CEO office walls. The task board and ASK ME board hang on the
 *  bottom wall, left of the door; the clock sits at the far end of the top wall,
 *  away from the room label. */
function ceoAnchors(o: Tile, bottom: number, machineStand: Tile): ProjectFloor['anchors'] {
  return {
    clock: { x: o.x + 12, y: o.y },
    calendar: { x: o.x + 9, y: o.y },
    boards: { x: o.x + 1, y: bottom },
    askMe: { x: o.x + 8, y: bottom },
    machine: { x: machineStand.x, y: machineStand.y - 3 }
  };
}

/** Walls of one room plus its two-tile door on the bottom wall. */
function drawRoomShell(grid: Grid, rx: number, top: number, bottom: number, kind: RoomKind): void {
  for (let x = rx; x < rx + ROOM_W; x++) { grid.wall(x, top); grid.wall(x, bottom); }
  for (let y = top; y <= bottom; y++) { grid.wall(rx, y); grid.wall(rx + ROOM_W - 1, y); }
  // The CEO door sits at the right end: the boards hang on that wall.
  const doorX = kind === 'ceo' ? rx + 12 : rx + 6;
  grid.open(doorX, bottom);
  grid.open(doorX + 1, bottom);
}

/** Desks in rows of three; returns their seat spawn points in claim order. */
function placeDesks(grid: Grid, spec: FloorRoomSpec, rx: number, top: number): Array<{ name: string; tile: Tile }> {
  const count = spec.kind === 'ceo' ? 1 : deskRows(spec.desks) * DESKS_PER_ROW;
  const seats: Array<{ name: string; tile: Tile }> = [];
  for (let i = 0; i < count; i++) {
    const sx = rx + FIRST_DESK_X + (i % DESKS_PER_ROW) * DESK_DX;
    const sy = top + FIRST_DESK_Y + Math.floor(i / DESKS_PER_ROW) * DESK_ROW_STEP;
    for (const [layer, dx, dy, gid] of DESK_STAMP) grid.set(layer, sx + dx, sy + dy, gid);
    grid.set('coll', sx, sy, 0);
    seats.push({ name: spec.kind === 'ceo' ? 'desk-ceo' : `room-${spec.id}-${i + 1}`, tile: { x: sx, y: sy } });
  }
  return seats;
}

export function buildProjectFloor(input: { techLeadDesks: number; projects: FloorRoomSpec[]; labels: { ceo: string; techLeads: string; cafe: string } }): ProjectFloor {
  const top: FloorRoomSpec[] = [
    { id: 'ceo', kind: 'ceo', label: input.labels.ceo, desks: 1 },
    { id: 'tech-leads', kind: 'techLeads', label: input.labels.techLeads, desks: input.techLeadDesks },
    { id: 'cafe', kind: 'cafe', label: input.labels.cafe, desks: 0 }
  ];
  const bands: FloorRoomSpec[][] = [top];
  for (let i = 0; i < input.projects.length; i += MAX_COLS) bands.push(input.projects.slice(i, i + MAX_COLS));

  const cols = Math.max(top.length, Math.min(MAX_COLS, input.projects.length));
  const spineX = cols * COL_STRIDE + 1;
  const W = spineX + SPINE_W + 1;
  const bandHeights = bands.map((band, b) =>
    Math.max(...band.map((r) => (r.kind === 'cafe' ? CAFE_H : roomHeight(deskRows(r.desks)))), b === 0 ? CAFE_H : 0));
  const H = bandHeights.reduce((h, bh) => h + bh + CORRIDOR_H, 0) + 1;

  const grid = new Grid(W, H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) grid.set('floor', x, y, floorGid(x, y));
  for (let x = 0; x < W; x++) { grid.wall(x, 0); grid.wall(x, H - 1); }
  for (let y = 0; y < H; y++) { grid.wall(0, y); grid.wall(W - 1, y); }

  const rooms: FloorRoom[] = [];
  const spawns: Array<{ name: string; tile: Tile }> = [];
  let bandTop = 0;
  bands.forEach((band, b) => {
    const bottom = bandTop + bandHeights[b] - 1;
    band.forEach((spec, c) => {
      const rx = c * COL_STRIDE;
      drawRoomShell(grid, rx, bandTop, bottom, spec.kind);
      const seats = spec.kind === 'cafe' ? [] : placeDesks(grid, spec, rx, bandTop);
      spawns.push(...seats);
      rooms.push({
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        rect: { x: rx + 1, y: bandTop + 1, width: ROOM_W - 2, height: bottom - bandTop - 1 },
        seatNames: seats.map((s) => s.name),
        labelTile: { x: rx + 1, y: bandTop }
      });
    });
    for (let y = bottom + 1; y <= bottom + CORRIDOR_H; y++) for (let x = 1; x < W - 1; x++) grid.open(x, y);
    bandTop = bottom + 1 + CORRIDOR_H;
  });
  for (let y = 1; y < H - 1; y++) for (let x = spineX; x < spineX + SPINE_W; x++) grid.open(x, y);

  const cafe = cafeLayout(CAFE_ORIGIN);
  spawns.push(...cafe.spots);
  const anchors = ceoAnchors(CEO_ORIGIN, bandHeights[0] - 1, cafe.coffee.machineStand);

  const entrance: Tile = { x: spineX + 1, y: H - 2 };
  grid.open(entrance.x, H - 1);
  spawns.push({ name: 'entrance', tile: entrance });

  const boardStands = boardStandTiles(anchors.boards);
  const unreachable = findUnreachable(W, H, grid.layers.coll, entrance, [
    ...spawns.map((s) => s.tile),
    cafe.coffee.trayStand, cafe.coffee.machineStand, cafe.coffee.sinkStand,
    boardStands.pin, boardStands.take, boardStands.archive
  ]);
  if (unreachable.length) throw new Error(`floor layout has unreachable tiles: ${JSON.stringify(unreachable)}`);

  return {
    map: toTiledMap(W, H, grid.layers, spawns, rooms),
    rooms,
    // Rooms claim seats in this order: CEO, tech leads, then projects.
    seatNames: rooms.flatMap((r) => r.seatNames),
    cafeSeatNames: cafe.cafeSeatNames,
    cafeStands: cafe.cafeStands,
    coffee: cafe.coffee,
    anchors,
    entrance
  };
}

/** Where agents stand to pin, take and archive task notes: one row below the
 *  boards. The office floor's own tiles are exactly these offsets from (6,10). */
export function boardStandTiles(boards: Tile): { pin: Tile; take: Tile; archive: Tile } {
  return {
    pin: { x: boards.x + 2, y: boards.y + 1 },
    take: { x: boards.x + 3, y: boards.y + 1 },
    archive: { x: boards.x + 6, y: boards.y + 1 }
  };
}

/** Flood fill from the entrance over walkable tiles (collision 0). Every target
 *  must itself be walkable: seats named room-* are not force-walked at runtime. */
export function findUnreachable(W: number, H: number, coll: number[], from: Tile, targets: Tile[]): Tile[] {
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && coll[y * W + x] === 0;
  const seen = new Set<string>([`${from.x},${from.y}`]);
  const queue: Tile[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const { x, y } = queue[head];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const key = `${nx},${ny}`;
      if (seen.has(key) || !walk(nx, ny)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return targets.filter((t) => !seen.has(`${t.x},${t.y}`));
}

/** Tiled map layer and object shapes this generator writes. */
interface TileLayerOut { id: number; name: string; type: 'tilelayer'; data: number[]; width: number; height: number; x: 0; y: 0; opacity: 1; visible: true }
interface ObjectOut { id: number; name: string; point?: true; x: number; y: number; width: number; height: number; rotation: 0; type: ''; visible: true }
interface ObjectLayerOut { id: number; name: string; type: 'objectgroup'; objects: ObjectOut[]; draworder: 'topdown'; opacity: 1; visible: true; x: 0; y: 0 }

function toTiledMap(W: number, H: number, L: Record<LayerKey, number[]>, spawns: Array<{ name: string; tile: Tile }>, rooms: FloorRoom[]): TiledMap {
  let oid = 1;
  const tileLayer = (name: string, data: number[], id: number): TileLayerOut =>
    ({ id, name, type: 'tilelayer', data, width: W, height: H, x: 0, y: 0, opacity: 1, visible: true });
  const spawnObjs: ObjectOut[] = spawns.map((s) => ({
    id: oid++, name: s.name, point: true, x: s.tile.x * TILE, y: s.tile.y * TILE, width: 0, height: 0, rotation: 0, type: '', visible: true
  }));
  const zoneObjs: ObjectOut[] = rooms.map((r) => ({
    id: oid++,
    name: r.kind === 'cafe' ? 'cafeteria' : `room:${r.id}`,
    x: r.rect.x * TILE, y: r.rect.y * TILE, width: r.rect.width * TILE, height: r.rect.height * TILE,
    rotation: 0, type: '', visible: true
  }));
  const layers: Array<TileLayerOut | ObjectLayerOut> = [
    tileLayer('floor', L.floor, 1),
    tileLayer('walls', L.walls, 2),
    tileLayer('furniture-below', L.below, 3),
    tileLayer('furniture-above', L.above, 4),
    tileLayer('collision', L.coll, 5),
    { id: 6, name: 'spawn-points', type: 'objectgroup', objects: spawnObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
    { id: 7, name: 'zones', type: 'objectgroup', objects: zoneObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 }
  ];
  const map = {
    compressionlevel: -1, infinite: false, orientation: 'orthogonal', renderorder: 'right-down',
    width: W, height: H, tilewidth: TILE, tileheight: TILE, nextlayerid: 99, nextobjectid: oid,
    version: '1.10', tiledversion: '1.10.2', type: 'map',
    tilesets: [
      { firstgid: 1, columns: 16, image: '../tilesets/office-tileset.png', imageheight: 512, imagewidth: 256, margin: 0, name: 'office-tileset', spacing: 0, tilecount: 512, tileheight: 16, tilewidth: 16 },
      { firstgid: 513, source: 'A5 Office Floors & Walls.tsx' },
      { firstgid: 1025, source: 'interiors.tsx' }
    ],
    layers
  };
  return map as TiledMap;
}
