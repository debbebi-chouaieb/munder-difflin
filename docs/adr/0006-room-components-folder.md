# 0006. Room panel components live in `components/room/`

- **Status**: Accepted
- **Date**: 2026-11-20
- **Scope**: renderer, `src/renderer/src/components`

## Context
ADR 0005 adds a project room panel to the right panel: a session list, the lead terminal, a trust dialog, a
large-session confirmation and two task tables. That is four or five components plus a pure model (open flow,
error-code strings, board counts). `components/` is flat today, with 68 files, and only `git/`,
`memoryGraph/` and `triggers/` are grouped.

## Options
### A. A `components/room/` folder
Pros: the room panel is one feature with one entry point (`RoomPanel`); its parts are found together and can be
moved or removed together. Matches the existing feature folders (`git/`, `triggers/`).
Cons: one more import path segment.
Testing impact: the pure model sits next to its components and is loaded by `test/room-panel.test.cjs`.

### B. Flat files in `components/`
Pros: matches most of the folder.
Cons: five more `Room*` files in a 68-file folder; the boundary of the feature is only a name prefix.
Testing impact: none.

## Decision
We chose **A**. `components/room/` holds `RoomPanel`, its parts and `roomPanelModel.ts` (pure, no React).
Outside the folder, only `RoomPanel` and the model's `rightPanelView` are used (by `App`). Room selection and
board counts live in a small store, `store/roomPanel.ts` with `store/roomBoardCounts.ts`, not in the agent
store, so the agent store gains only one call (selecting an agent clears the room) and no store depends on a
component folder. The embedded terminal is shared with the agent panel (`components/AgentTerminalPane.tsx`).

## Consequences
- Floor drawing stays in `scene/office/`: `RoomBoards` (click targets and count boards, next to `RoomLights`)
  reads counts from `store/roomPanel.ts`.
- Revisit if the folder grows a second entry point; split it then.
