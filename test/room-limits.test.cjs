'use strict';

// Room lead terminal limits (ADR 0005, Rooms-d): config clamps and defaults,
// and the smaller scrollback for room lead terminals.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const limits = loadTs('src/shared/roomLimits.ts');

test('pty cap: whole numbers 1 to 10, else the default 3', () => {
  assert.equal(limits.roomPtyCap(undefined), 3);
  assert.equal(limits.roomPtyCap(1), 1);
  assert.equal(limits.roomPtyCap(10), 10);
  for (const bad of [0, -1, 11, 2.5, '4', null, NaN, Infinity]) assert.equal(limits.roomPtyCap(bad), 3, String(bad));
});

test('idle minutes: 0 (never) to one day, else the default 30', () => {
  assert.equal(limits.roomIdleMinutes(undefined), 30);
  assert.equal(limits.roomIdleMinutes(0), 0);
  assert.equal(limits.roomIdleMinutes(1440), 1440);
  for (const bad of [-1, 1441, 1.5, '30', null]) assert.equal(limits.roomIdleMinutes(bad), 30, String(bad));
});

test('scrollback: room leads keep 10 000 lines, other terminals the pool default', () => {
  assert.equal(limits.ROOM_SCROLLBACK_LINES, 10_000);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/terminalPool.ts'), 'utf8');
  assert.match(src, /scrollback: terminalScrollback\(ptyId\),/);
  assert.match(src, /return isLeadAgentId\(ptyId\) \? ROOM_SCROLLBACK_LINES : 100000;/);
});

test('idle: only hidden room leads silent past the limit stop; 0 minutes stops nothing', () => {
  const { idleLeadsToStop } = loadTs('src/renderer/src/components/room/roomIdle.ts');
  const projects = [{ id: 'app', leadAgentId: null }, { id: 'web', leadAgentId: 'lead--web' }, { id: 'api', leadAgentId: null }];
  const now = 100 * 60_000;
  const ptys = [
    { id: 'lead--app', lastOutputAt: now - 31 * 60_000 },  // hidden, silent: stops
    { id: 'lead--web', lastOutputAt: now - 31 * 60_000 },  // on screen: stays
    { id: 'lead--api', lastOutputAt: now - 29 * 60_000 },  // printed recently: stays
    { id: 'lead--gone', lastOutputAt: 0 },                 // project gone: left alone
    { id: 'pty-dev-1', lastOutputAt: 0 }                   // not a lead: never
  ];
  const onScreen = (id) => id === 'lead--web';
  assert.deepEqual(idleLeadsToStop(ptys, projects, onScreen, now, 30), [{ projectId: 'app', ptyId: 'lead--app' }]);
  assert.deepEqual(idleLeadsToStop(ptys, projects, onScreen, now, 0), []);
});

test('idle wiring: App runs the check with the configured minutes, off until a hive is open', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/App.tsx'), 'utf8');
  assert.match(app, /useRoomIdleShutdown\(hiveOpened \? config\?\.roomIdleMinutes : 0\);/);
  const hook = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useRoomIdleShutdown.ts'), 'utf8');
  assert.match(hook, /const res = await window\.cth\.roomCloseTerminal\(stop\.projectId\);\s*if \(res\.ok\) \{\s*\/\/[^\n]*\n\s*disposeTerminal\(stop\.ptyId\);/);
});
