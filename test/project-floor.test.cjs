'use strict';

// Projects floor rules (ADR 0002): which room an agent sits in, how big rooms
// are, when the floor rebuilds, and what the lights show.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const spec = loadTs('src/renderer/src/scene/office/projectFloorSpec.ts');

const project = (id, enabled) => ({
  id, name: id, path: `D:\\zetabox\\${id}`, enabled, parallel: false,
  zetahubKey: null, zetahubKeySource: null, hasClaudeMd: false, agents: [], leadAgentId: null
});
const agent = (id, cwd, status = 'idle', extra = {}) => ({ id, cwd, status, ...extra });

test('agents sit in their ticked project room, else with the tech leads', () => {
  const ticked = [project('mcx', true)];
  assert.equal(spec.roomIdForAgent(agent('g', 'C:\\hive', 'idle', { isGod: true }), ticked), 'ceo');
  assert.equal(spec.roomIdForAgent(agent('a', 'D:\\zetabox\\mcx\\platform'), ticked), 'mcx');
  assert.equal(spec.roomIdForAgent(agent('b', 'D:\\zetabox\\mdm-core'), ticked), 'tech-leads', 'unticked project');
  assert.equal(spec.roomIdForAgent(agent('c', 'C:\\hive\\worktrees\\x'), ticked), 'tech-leads');
});

test('only ticked projects get rooms, sized by their agents', () => {
  const projects = [project('mcx', true), project('mdm', false), project('dusk', true)];
  const agents = [
    agent('g', 'C:\\hive', 'idle', { isGod: true }),
    agent('a1', 'D:\\zetabox\\mcx'), agent('a2', 'D:\\zetabox\\mcx'), agent('a3', 'D:\\zetabox\\mcx'),
    agent('b1', 'D:\\zetabox\\mdm'),
    agent('x', 'D:\\zetabox\\mcx', 'idle', { archived: true }),
    agent('p', 'C:\\hive', 'idle', { isAssistant: true })
  ];
  const result = spec.floorSpec(projects, agents);
  assert.deepEqual(result.projects.map((p) => [p.id, p.desks]), [['mcx', 6], ['dusk', 3]]);
  assert.equal(result.techLeadDesks, 3, 'the unticked project agent waits with the tech leads');
});

test('the floor rebuilds on room changes, not on every status change', () => {
  const projects = [project('mcx', true)];
  const before = spec.floorSpecKey(spec.floorSpec(projects, [agent('a', 'D:\\zetabox\\mcx', 'idle')]));
  const working = spec.floorSpecKey(spec.floorSpec(projects, [agent('a', 'D:\\zetabox\\mcx', 'working')]));
  assert.equal(before, working);
  const unticked = spec.floorSpecKey(spec.floorSpec([project('mcx', false)], [agent('a', 'D:\\zetabox\\mcx')]));
  assert.notEqual(before, unticked);
});

test('project lights follow activity; leaving rooms go dark; shared rooms stay lit', () => {
  assert.equal(spec.roomDarkness('project', ['idle', 'working'], false), spec.LIGHT_ON);
  assert.equal(spec.roomDarkness('project', ['idle'], false), spec.LIGHT_DIM);
  assert.equal(spec.roomDarkness('project', [], false), spec.LIGHT_DIM);
  assert.equal(spec.roomDarkness('project', ['working'], true), spec.LIGHT_OFF);
  assert.equal(spec.roomDarkness('ceo', [], false), spec.LIGHT_ON);
  assert.equal(spec.roomDarkness('techLeads', ['idle'], false), spec.LIGHT_ON);
});

test('the hand-made floors keep their prop and board positions', () => {
  // Office (and B99, which never set these) — the values OfficeFloor used to hard-code.
  const classic = spec.resolveAnchors({ boards: { x: 6, y: 10 } }, false);
  assert.deepEqual(classic.machine, { x: 26, y: 17 });
  assert.deepEqual(classic.askMe, { x: 14, y: 10 });
  assert.deepEqual(classic.stands, { pin: { x: 8, y: 11 }, take: { x: 9, y: 11 }, archive: { x: 12, y: 11 } });
  const b99 = spec.resolveAnchors({ boards: { x: 20, y: 3 } }, false);
  assert.deepEqual(b99.stands.pin, { x: 8, y: 11 }, 'B99 keeps the stands it had');
  const generated = spec.resolveAnchors({ boards: { x: 1, y: 13 }, askMe: { x: 8, y: 13 }, machine: { x: 32, y: 9 } }, true);
  assert.deepEqual(generated.stands.pin, { x: 3, y: 14 });
  assert.deepEqual(generated.askMe, { x: 8, y: 13 });
});

test('agents claim a free seat in their room, then fall back', () => {
  const seatRoom = [undefined, 'tech-leads', 'tech-leads', 'mcx', 'mcx', undefined];
  assert.equal(spec.pickSeat(new Set(), seatRoom, 'mcx'), 3);
  assert.equal(spec.pickSeat(new Set([3]), seatRoom, 'mcx'), 4);
  assert.equal(spec.pickSeat(new Set([3, 4]), seatRoom, 'mcx'), null, 'room full');
  assert.equal(spec.pickSeat(new Set([1]), seatRoom), 2, 'no room: any seat but the CEO desk');
  assert.equal(spec.pickSeat(new Set(), [undefined], undefined), null, 'seat 0 is never handed out');
});

test('walks may take longer on a large generated floor only', () => {
  assert.equal(spec.walkTimeoutSeconds(false, 34, 22), 20, 'the office keeps 20 s');
  assert.equal(spec.walkTimeoutSeconds(true, 20, 10), 20, 'never below the classic value');
  const big = spec.walkTimeoutSeconds(true, 61, 70);
  assert.ok(big >= (61 + 70) / 3, `the longest corridor walk fits in ${big}s`);
});

test('the placement signature ignores status but not folder or archive', () => {
  const a = [agent('a', 'D:\\x', 'idle')];
  assert.equal(spec.placementSignature(a), spec.placementSignature([agent('a', 'D:\\x', 'working')]));
  assert.notEqual(spec.placementSignature(a), spec.placementSignature([agent('a', 'D:\\y', 'idle')]));
  assert.notEqual(spec.placementSignature(a), spec.placementSignature([agent('a', 'D:\\x', 'idle', { archived: true })]));
});

test('the prep assistant is counted with the tech leads, so the free desk stays free', () => {
  const result = spec.floorSpec([], [agent('p', 'C:\\hive', 'idle', { isAssistant: true }), agent('w', 'C:\\hive')]);
  assert.equal(result.techLeadDesks, 3);
  const crowded = spec.floorSpec([], [1, 2, 3].map((n) => agent(`w${n}`, 'C:\\hive')).concat([agent('p', 'C:\\hive', 'idle', { isAssistant: true })]));
  assert.equal(crowded.techLeadDesks, 6);
});

test('idle wandering stays in the room and walks back into it from outside', () => {
  const { pickWanderTarget } = loadTs('src/renderer/src/scene/office/wander.ts');
  const room = { x: 10, y: 10, width: 5, height: 4 };
  const everywhere = () => true;
  let seed = 0;
  const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 50; i++) {
    const t = pickWanderTarget({ x: 12, y: 11 }, room, everywhere, random);
    assert.ok(t && t.x >= 10 && t.x < 15 && t.y >= 10 && t.y < 14, `inside: ${JSON.stringify(t)}`);
  }
  const back = pickWanderTarget({ x: 40, y: 40 }, room, everywhere, random);
  assert.ok(back && back.x >= 10 && back.x < 15 && back.y >= 10 && back.y < 14, 'an agent far outside heads home');
  assert.equal(pickWanderTarget({ x: 40, y: 40 }, room, () => false, random), null);
  const free = pickWanderTarget({ x: 5, y: 5 }, undefined, everywhere, random);
  assert.ok(free && Math.abs(free.x - 5) <= 6 && Math.abs(free.y - 5) <= 6, 'unbounded: nearby, as before');
});
