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
We chose **A**, added as a new "Projects" theme. The existing Office and Brooklyn 99 themes stay selectable.

- Lights: a dark overlay per room zone with eased alpha (`RoomLights`, modelled on `DeskScreen`); a dark room also
  turns its desk monitors off.
- Agents claim seats in their own room; idle wandering stays inside the room.
- The map is rebuilt when the set of projects changes, not when one is enabled or disabled (that only changes
  lights).

## Consequences
- The camera needs dynamic bounds; with many projects the floor is larger than the view.
- Errands and the cafeteria keep working through layout anchors instead of fixed tiles.
- A pure test checks that every seat is reachable and every room exists.
