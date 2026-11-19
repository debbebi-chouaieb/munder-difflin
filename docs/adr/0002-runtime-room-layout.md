# 0002. Office rooms generated at runtime, with room lights

- **Status**: Accepted
- **Date**: 2026-11-19
- **Scope**: module `scene/office`

## Context
The floor is one fixed Tiled map per theme (`office.tmj` 34x22, `brooklyn99.tmj` 36x24) with about 15 desks claimed
in arrival order. `Agent.project` never affects seating and there is no lighting system. We want a CEO room, a
tech-leads room and one room per project, and an unticked project must turn its room's lights off. The workspace
already has 17 folders, so a fixed number of rooms is too small.

## Options
### A. Generate the map at runtime
Port `tools/gen-b99-map.cjs` (walls, doors, desk stamp, zones, flood-fill reachability check) into a pure
`buildFloor(rooms)` function. Rooms are sized from their agent count (DESIGN.md section 9.3).
Pros: scales with the project count; layout is testable as data.
Cons: most work; hard-coded prop coordinates in `OfficeFloor.tsx` must move to layout anchors.

### B. Hand-drawn map with N fixed room slots
Pros: faster, art fully controlled. Cons: capped at N projects.

### C. Keep the current map, label desk zones per project
Pros: least work. Cons: not rooms; lights would cover odd shapes.

## Decision
We chose **A** (`scene/office/roomLayout.ts`), shown as a floor mode, not a theme (user decisions 2026-11-19).

- Floor mode: "Rooms" is the default once a workspace is picked; a sidebar toggle switches to the classic floor
  (the configured Office or Brooklyn 99 theme). It is not a theme in the picker, because a theme switch archives
  every agent but the god; switching floor mode only reseats agents. Stored per viewer (`cth.floorMode`).
- Rooms: a top band with the CEO office, the tech-leads room and the café, then **only ticked projects**, four per
  band, each band above a corridor; a spine on the right joins the corridors to the entrance.
- Size: desks in rows of three, always one free desk; a room grows by a whole row, so the floor rebuilds only when
  a row is added or removed (DESIGN.md §9.3).
- Seating: the god in the CEO office, agents of a ticked project in its room, every other agent (global agents,
  hive workers, agents of an unticked project) in the tech-leads room. Idle wandering stays inside the room.
- Lights (`RoomLights`): a project room is lit while one of its agents works and dimmed when all are idle. An
  unticked project's room fades dark, and about 1.2 s later the floor is rebuilt without it. Shared rooms stay lit.
- The generated rooms reuse the office tileset, desk stamp and monitors. They have no errand props, no clock art
  (so no clock-to-quit hotspot) and a bare café: cups and the sink draw on the floor, as on Brooklyn 99.
- Walk give-up times (coffee runs, breaks, errands, board moves) scale with the map size on this floor only; the
  hand-made floors keep 20 s and 30 s.
- While the Rooms floor is on, the theme picker shows a note instead of the grid: a theme switch archives agents
  and would change nothing visible.

## Consequences
- Deferred: camera bounds and focus. The camera fits the whole map, so with many projects rooms render small and
  labels are not counter-scaled. Clicking a project in the sidebar to center its room is not built yet. Tracked in
  `docs/in-progress.md`.
- Errands and the cafeteria keep working through layout anchors instead of fixed tiles.
- A pure test checks that every seat is reachable and every room exists.
