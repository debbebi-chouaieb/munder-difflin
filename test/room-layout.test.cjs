'use strict';

// Projects floor generator (ADR 0002): rooms per ticked project, sized by agent
// count, every seat reachable from the entrance.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const layout = loadTs('src/renderer/src/scene/office/roomLayout.ts');
const labels = { ceo: 'CEO', techLeads: 'Tech leads', cafe: 'Café' };
const project = (id, desks) => ({ id, kind: 'project', label: id, desks });

function layer(map, name) {
  return map.layers.find((l) => l.name === name);
}

test('room size grows by whole rows of three, always with a free desk', () => {
  assert.equal(layout.desksFor(0), 3);
  assert.equal(layout.desksFor(2), 3);
  assert.equal(layout.desksFor(3), 6, 'the fourth agent gets a new row');
  assert.equal(layout.desksFor(5), 6);
  assert.equal(layout.deskRows(7), 3);
});

test('no projects: CEO office, tech leads and café only', () => {
  const floor = layout.buildProjectFloor({ techLeadDesks: 3, projects: [], labels });
  assert.deepEqual(floor.rooms.map((r) => r.kind), ['ceo', 'techLeads', 'cafe']);
  assert.equal(floor.seatNames[0], 'desk-ceo', 'the CEO desk is claimed first');
  assert.equal(floor.cafeSeatNames.length, 4);
});

test('one room per ticked project, four per band, seats in claim order', () => {
  const projects = ['a', 'b', 'c', 'd', 'e'].map((id) => project(id, 3));
  projects[4].desks = 9;
  const floor = layout.buildProjectFloor({ techLeadDesks: 3, projects, labels });
  const rooms = floor.rooms.filter((r) => r.kind === 'project');
  assert.deepEqual(rooms.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(rooms[0].rect.y, rooms[3].rect.y, 'a..d share a band');
  assert.ok(rooms[4].rect.y > rooms[0].rect.y, 'e starts the next band');
  assert.equal(rooms[4].seatNames.length, 9);
  assert.ok(rooms[4].rect.height > rooms[0].rect.height, 'a bigger team gets a taller room');
  const ids = floor.seatNames;
  assert.ok(ids.indexOf('room-a-1') < ids.indexOf('room-e-1'));
  assert.equal(new Set(ids).size, ids.length, 'seat names are unique');
});

test('every seat, café spot and coffee stand is reachable from the entrance', () => {
  const projects = Array.from({ length: 11 }, (_, i) => project(`p${i}`, i % 3 === 0 ? 7 : 3));
  const floor = layout.buildProjectFloor({ techLeadDesks: 9, projects, labels });
  const { map } = floor;
  const coll = layer(map, 'collision').data;
  const spawnTiles = layer(map, 'spawn-points').objects.map((o) => ({ x: o.x / 16, y: o.y / 16 }));
  const targets = [...spawnTiles, floor.coffee.trayStand, floor.coffee.machineStand, floor.coffee.sinkStand];
  assert.deepEqual(layout.findUnreachable(map.width, map.height, coll, floor.entrance, targets), []);
  assert.equal(floor.rooms.filter((r) => r.kind === 'project').length, 11);
});

test('desks carry the office monitor so desk screens light up', () => {
  const floor = layout.buildProjectFloor({ techLeadDesks: 3, projects: [project('mcx', 3)], labels });
  const above = layer(floor.map, 'furniture-above');
  const seat = layer(floor.map, 'spawn-points').objects.find((o) => o.name === 'room-mcx-1');
  const sx = seat.x / 16, sy = seat.y / 16;
  assert.equal(above.data[(sy - 2) * floor.map.width + sx], 365, 'monitor two rows above the seat');
  const coll = layer(floor.map, 'collision').data;
  assert.equal(coll[sy * floor.map.width + sx], 0, 'the seat itself is walkable');
});

test('seats are walkable themselves, and the board stands are reachable', () => {
  const floor = layout.buildProjectFloor({ techLeadDesks: 3, projects: [project('mcx', 6)], labels });
  const coll = layer(floor.map, 'collision').data;
  const W = floor.map.width;
  for (const name of floor.seatNames) {
    const s = layer(floor.map, 'spawn-points').objects.find((o) => o.name === name);
    assert.equal(coll[(s.y / 16) * W + s.x / 16], 0, `${name} is not force-walked at runtime, so it must be free`);
  }
  const stands = layout.boardStandTiles(floor.anchors.boards);
  assert.deepEqual(layout.findUnreachable(W, floor.map.height, coll, floor.entrance, [stands.pin, stands.take, stands.archive]), []);
});

test('the CEO label, clock, boards and door do not overlap', () => {
  const floor = layout.buildProjectFloor({ techLeadDesks: 3, projects: [], labels });
  const ceo = floor.rooms.find((r) => r.kind === 'ceo');
  const { clock, askMe, boards } = floor.anchors;
  assert.notDeepEqual(clock, ceo.labelTile, 'the clock is not under the label');
  const coll = layer(floor.map, 'collision').data;
  const bottom = boards.y;
  const doorTiles = [];
  for (let x = ceo.rect.x - 1; x <= ceo.rect.x + ceo.rect.width; x++) if (coll[bottom * floor.map.width + x] === 0) doorTiles.push(x);
  assert.ok(doorTiles.length === 2, `one two-tile door, got ${doorTiles}`);
  // ASK ME is drawn 25 px right of its tile and is about 2 tiles wide.
  assert.ok(askMe.x + 25 / 16 + 2 <= doorTiles[0], 'the ASK ME board ends before the door');
});

test('a floor that cannot be walked is refused, not drawn', () => {
  const W = 5, H = 3;
  const coll = [1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1];
  assert.deepEqual(layout.findUnreachable(W, H, coll, { x: 1, y: 1 }, [{ x: 3, y: 1 }]), [{ x: 3, y: 1 }]);
});

test('rooms are zones the floor can light and bound wandering with', () => {
  const floor = layout.buildProjectFloor({ techLeadDesks: 3, projects: [project('mcx', 3)], labels });
  const zones = layer(floor.map, 'zones').objects.map((z) => z.name);
  assert.ok(zones.includes('room:mcx'));
  assert.ok(zones.includes('room:ceo'));
  assert.ok(zones.includes('cafeteria'));
  for (const room of floor.rooms) {
    for (const name of room.seatNames) {
      const s = layer(floor.map, 'spawn-points').objects.find((o) => o.name === name);
      const x = s.x / 16, y = s.y / 16;
      assert.ok(x >= room.rect.x && x < room.rect.x + room.rect.width && y >= room.rect.y && y < room.rect.y + room.rect.height,
        `${name} is inside ${room.id}`);
    }
  }
});
