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
