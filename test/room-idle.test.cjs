'use strict';

// Idle shutdown of room leads, owned by main (ADR 0005, amended 2026-11-23): a
// lead stops when no window shows it and it had no output or input for the limit,
// re-checked right before the kill.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createRoomIdleSweeper } = loadTs('src/main/roomIdle.ts');

const MIN = 60_000;

function sweeper(over = {}) {
  const now = over.now ?? 100 * MIN;
  const leads = over.leads ?? [];
  const shown = new Set(over.shown ?? []);
  const used = over.used ?? {};
  const calls = { stop: [], log: [] };
  const s = createRoomIdleSweeper({
    idleMinutes: () => over.minutes ?? 30,
    liveLeads: () => leads,
    isShown: (id) => shown.has(id),
    lastUsed: (id) => used[id] ?? 0,
    stop: over.stop ?? (async (id, stillIdle) => { calls.stop.push(id); return stillIdle(); }),
    now: () => now,
    log: (m) => calls.log.push(m)
  });
  return { s, calls, shown, used };
}

test('a lead no window shows, silent and untouched past the limit, stops', async () => {
  const { s, calls } = sweeper({ leads: [{ id: 'lead--app', lastOutputAt: 60 * MIN }] });
  assert.deepEqual(await s.sweep(), ['lead--app']);
  assert.deepEqual(calls.stop, ['lead--app']);
  assert.equal(calls.log.length, 1);
});

test('shown anywhere, recent output, or recent input keeps a lead', async () => {
  const leads = [
    { id: 'lead--shown', lastOutputAt: 0 },
    { id: 'lead--talking', lastOutputAt: 80 * MIN },
    { id: 'lead--typed', lastOutputAt: 0 }
  ];
  const { s, calls } = sweeper({ leads, shown: ['lead--shown'], used: { 'lead--typed': 90 * MIN } });
  assert.deepEqual(await s.sweep(), []);
  assert.deepEqual(calls.stop, []);
});

test('0 minutes turns it off', async () => {
  const { s, calls } = sweeper({ minutes: 0, leads: [{ id: 'lead--app', lastOutputAt: 0 }] });
  assert.deepEqual(await s.sweep(), []);
  assert.deepEqual(calls.stop, []);
});

test('the re-check right before the kill sees a window that showed the lead meanwhile', async () => {
  let ref;
  ref = sweeper({
    leads: [{ id: 'lead--app', lastOutputAt: 0 }],
    stop: async (id, stillIdle) => { ref.shown.add(id); return stillIdle(); }
  });
  assert.deepEqual(await ref.s.sweep(), []);
});

test('a failed stop is logged and the sweep goes on; sweeps never overlap', async () => {
  const stops = [];
  let release;
  const { s, calls } = sweeper({
    leads: [{ id: 'lead--a', lastOutputAt: 0 }, { id: 'lead--b', lastOutputAt: 0 }],
    stop: async (id) => {
      stops.push(id);
      if (id === 'lead--a') throw new Error('boom');
      await new Promise((r) => { release = r; });
      return true;
    }
  });
  const first = s.sweep();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await s.sweep(), [], 'a second sweep while one runs does nothing');
  release();
  assert.deepEqual(await first, ['lead--b']);
  assert.deepEqual(stops, ['lead--a', 'lead--b']);
  assert.ok(calls.log.some((m) => m.includes('boom')));
});

test('wiring: main records only live leads, stops through the room close path, renderer reports from the pool', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /ipcMain\.on\('room:leadShown', \(evt, agentId: unknown, shown: unknown\) => \{\s*if \(typeof agentId !== 'string' \|\| !isLeadAgentId\(agentId\) \|\| typeof shown !== 'boolean'\) return;\s*if \(shown && !ptyManager\.has\(agentId\)\) return;/);
  assert.match(main, /const res = await roomHandlers\.closeTerminal\(project\.id, stillIdle\);/);
  assert.match(main, /idleMinutes: \(\) => roomIdleMinutes\(readConfig\(\)\.roomIdleMinutes\),/);
  const pool = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/terminalPool.ts'), 'utf8');
  assert.equal((pool.match(/reportLeadShown\(entry\);/g) ?? []).length, 3, 'attach, detach and dispose report');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  assert.match(preload, /ipcRenderer\.send\('room:leadShown', agentId, shown\)/);
  const hive = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');
  assert.match(hive, /if \(isLeadAgentId\(e\.id\)\) disposeTerminal\(e\.id\);/);
});
