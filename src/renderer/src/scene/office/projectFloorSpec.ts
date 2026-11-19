/**
 * What the Projects floor should contain (ADR 0002), from the ticked projects
 * and the agents on the floor. Pure, so it is unit-testable.
 */
import { projectIdForCwd, type Project } from '@shared/project';
import { boardStandTiles, desksFor, type FloorRoomSpec, type Tile } from './roomLayout';

/** What the floor rules read from an agent. */
export interface FloorAgent {
  id: string;
  cwd: string;
  isGod?: boolean;
  archived?: boolean;
}

export const CEO_ROOM = 'ceo';
export const TECH_LEADS_ROOM = 'tech-leads';

/** Statuses that count as work for the room lights. */
const BUSY = new Set(['working', 'thinking', 'compacting']);

/**
 * The room an agent sits in: the CEO office for the god, its project's room
 * when that project is ticked, otherwise the tech-leads room (global agents,
 * hive workers, and agents of an unticked project).
 */
export function roomIdForAgent(agent: FloorAgent, ticked: Pick<Project, 'id' | 'path'>[]): string {
  if (agent.isGod) return CEO_ROOM;
  return projectIdForCwd(agent.cwd, ticked) ?? TECH_LEADS_ROOM;
}

export interface FloorSpec {
  techLeadDesks: number;
  projects: FloorRoomSpec[];
}

export function floorSpec(projects: Project[], agents: FloorAgent[]): FloorSpec {
  const ticked = projects.filter((p) => p.enabled);
  const counts = new Map<string, number>();
  for (const agent of agents) {
    // The prep assistant is counted: the floor seats it in the tech-leads room.
    if (agent.archived || agent.isGod) continue;
    const room = roomIdForAgent(agent, ticked);
    counts.set(room, (counts.get(room) ?? 0) + 1);
  }
  return {
    techLeadDesks: desksFor(counts.get(TECH_LEADS_ROOM) ?? 0),
    projects: ticked.map((p) => ({ id: p.id, kind: 'project' as const, label: p.name, desks: desksFor(counts.get(p.id) ?? 0) }))
  };
}

/** What decides where agents sit: changes on add, remove, archive or a new
 *  folder, never on a status change. */
export function placementSignature(agents: ReadonlyArray<Pick<FloorAgent, 'id' | 'cwd' | 'isGod' | 'archived'>>): string {
  return agents.map((a) => `${a.id}\u0001${a.cwd}\u0001${a.isGod ? 1 : 0}${a.archived ? 1 : 0}`).join('\u0002');
}

/** Stable key: the scene is rebuilt only when this changes. */
export function floorSpecKey(spec: FloorSpec): string {
  return [`tl:${spec.techLeadDesks}`, ...spec.projects.map((p) => `${p.id}:${p.desks}:${p.label}`)].join('|');
}

/**
 * First free seat index (seat 0 is the CEO desk, never handed out here). With a
 * room id, only that room's seats count; without one, any seat does.
 */
export function pickSeat(claims: ReadonlySet<number>, seatRoom: ReadonlyArray<string | undefined>, roomId?: string): number | null {
  for (let i = 1; i < seatRoom.length; i++) {
    if (claims.has(i)) continue;
    if (roomId !== undefined && seatRoom[i] !== roomId) continue;
    return i;
  }
  return null;
}

/** Tiles per second an avatar walks (Character SPEED 48 px/s on 16 px tiles). */
const WALK_TILES_PER_SECOND = 3;
/** The hand-made floors' original give-up time for a walk. */
const CLASSIC_WALK_TIMEOUT_S = 20;

/**
 * How long a coffee run, break, errand or board move may walk before it gives
 * up. The hand-made floors keep their 20 s; the generated floor can be much
 * larger, so it allows the longest corridor walk (width + height) with slack.
 */
export function walkTimeoutSeconds(generated: boolean, mapWidth: number, mapHeight: number): number {
  if (!generated) return CLASSIC_WALK_TIMEOUT_S;
  return Math.max(CLASSIC_WALK_TIMEOUT_S, Math.ceil(((mapWidth + mapHeight) / WALK_TILES_PER_SECOND) * 1.5));
}

/** Where the generated floor's anchors are absent, the office's original tiles. */
export function resolveAnchors(anchors: { boards: Tile; askMe?: Tile; machine?: Tile }, generated: boolean): {
  machine: Tile; askMe: Tile; stands: { pin: Tile; take: Tile; archive: Tile };
} {
  return {
    machine: anchors.machine ?? { x: 26, y: 17 },
    askMe: anchors.askMe ?? { x: 14, y: 10 },
    // The hand-made floors keep the office's stand tiles (B99 included, as before).
    stands: boardStandTiles(generated ? anchors.boards : { x: 6, y: 10 })
  };
}

/** Overlay darkness per room: 0 = lights on. */
export const LIGHT_ON = 0;
export const LIGHT_DIM = 0.35;
export const LIGHT_OFF = 0.7;

/**
 * Project rooms are lit while one of their agents works and dimmed otherwise;
 * a room on its way out (project just unticked) goes dark before it is removed.
 * The CEO office, the tech-leads room and the café stay lit.
 */
export function roomDarkness(kind: string, statuses: string[], leaving: boolean): number {
  if (leaving) return LIGHT_OFF;
  if (kind !== 'project') return LIGHT_ON;
  return statuses.some((s) => BUSY.has(s)) ? LIGHT_ON : LIGHT_DIM;
}
