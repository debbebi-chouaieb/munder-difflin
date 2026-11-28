'use strict';

// ADR 0017: one holder per room lead, shared by the room open, pty spawns of a
// lead and Forget trust.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { createLeadLock, spawnUnderLeadLock, spawnUnlessLead, LEAD_BUSY_ERROR, LEAD_SPAWN_REFUSED } = loadTs('src/main/leadLock.ts');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('lead lock: a held lead refuses a second holder and runs nothing', async () => {
  const lock = createLeadLock();
  const gate = deferred();
  const first = lock.run('lead--app', 'forget', () => gate.promise);
  assert.equal(lock.holder('lead--app'), 'forget');
  let ran = false;
  assert.equal(lock.run('lead--app', 'spawn', async () => { ran = true; }), null);
  assert.equal(ran, false);
  gate.resolve('done');
  assert.equal(await first, 'done');
  assert.equal(lock.holder('lead--app'), null);
});

test('lead lock: other leads are independent', async () => {
  const lock = createLeadLock();
  const gate = deferred();
  const first = lock.run('lead--app', 'open', () => gate.promise);
  assert.equal(await lock.run('lead--web', 'spawn', async () => 'web'), 'web');
  gate.resolve();
  await first;
});

test('lead lock: freed when the work rejects or throws synchronously', async () => {
  const lock = createLeadLock();
  await assert.rejects(lock.run('lead--app', 'open', async () => { throw new Error('spawn blew up'); }), /spawn blew up/);
  assert.equal(lock.holder('lead--app'), null);
  await assert.rejects(lock.run('lead--app', 'open', () => { throw new Error('sync'); }), /sync/);
  assert.equal(lock.holder('lead--app'), null);
});

test('pty spawn door: a lead spawn holds the lead while it runs', async () => {
  const lock = createLeadLock();
  const gate = deferred();
  const spawning = spawnUnderLeadLock(lock, { id: 'lead--app', hiveId: 'lead--app' }, () => gate.promise);
  assert.equal(lock.holder('lead--app'), 'spawn');
  gate.resolve({ ok: true });
  assert.deepEqual(await spawning, { ok: true });
  assert.equal(lock.holder('lead--app'), null);
});

test('pty spawn door: a held lead is refused with the busy error, the spawn never runs', async () => {
  const lock = createLeadLock();
  const gate = deferred();
  const forget = lock.run('lead--app', 'forget', () => gate.promise);
  let spawned = false;
  const res = await spawnUnderLeadLock(lock, { id: 'lead--app', hiveId: undefined }, async () => { spawned = true; return { ok: true }; });
  assert.deepEqual(res, { ok: false, error: LEAD_BUSY_ERROR });
  assert.equal(spawned, false);
  gate.resolve();
  await forget;
});

test('pty spawn door: other agents take no lock, even when a lead with a similar id is held', async () => {
  const lock = createLeadLock();
  const gate = deferred();
  const forget = lock.run('lead--app', 'forget', () => gate.promise);
  assert.deepEqual(await spawnUnderLeadLock(lock, { id: 'worker-app', hiveId: 'worker-app' }, async () => ({ ok: true })), { ok: true });
  gate.resolve();
  await forget;
});

test('pty spawn door: mismatched lead ids go to the spawn core, which refuses them', async () => {
  const lock = createLeadLock();
  let called = false;
  await spawnUnderLeadLock(lock, { id: 'lead--app', hiveId: 'other' }, async () => { called = true; return { ok: false, error: 'mismatch' }; });
  assert.equal(called, true);
  assert.equal(lock.holder('lead--app'), null);
});

test('pty spawn door: a second spawn of the same lead, or one during a room open, is refused', async () => {
  const lock = createLeadLock();
  const gate = deferred();
  const first = spawnUnderLeadLock(lock, { id: 'lead--app', hiveId: 'lead--app' }, () => gate.promise);
  assert.deepEqual(await spawnUnderLeadLock(lock, { id: 'lead--app', hiveId: 'lead--app' }, async () => ({ ok: true })), { ok: false, error: LEAD_BUSY_ERROR });
  gate.resolve({ ok: true });
  await first;

  const open = deferred();
  const opening = lock.run('lead--app', 'open', () => open.promise);
  assert.deepEqual(await spawnUnderLeadLock(lock, { id: 'lead--app', hiveId: 'lead--app' }, async () => ({ ok: true })), { ok: false, error: LEAD_BUSY_ERROR });
  open.resolve();
  await opening;
});

// ADR 0019: spawn options from outside main never start a lead.
test('outside doors: a lead id is refused and nothing runs; a mismatched lead id too; other agents run', async () => {
  let ran = 0;
  const spawn = async () => { ran++; return { ok: true }; };
  assert.deepEqual(await spawnUnlessLead({ id: 'lead--app', hiveId: 'lead--app' }, spawn), { ok: false, error: LEAD_SPAWN_REFUSED });
  assert.deepEqual(await spawnUnlessLead({ id: 'lead--app', hiveId: undefined }, spawn), { ok: false, error: LEAD_SPAWN_REFUSED });
  const mismatch = await spawnUnlessLead({ id: 'worker-1', hiveId: 'lead--app' }, spawn);
  assert.equal(mismatch.ok, false);
  assert.equal(ran, 0);
  assert.deepEqual(await spawnUnlessLead({ id: 'worker-1', hiveId: 'worker-1' }, spawn), { ok: true });
  assert.equal(ran, 1);
});
