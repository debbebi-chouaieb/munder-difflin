'use strict';

// Project room task tables (ADR 0005): ZetaHub rows from the zetahub-sync cache,
// local "No ticket yet" bullets, and a local-work path that can never leave the
// project or follow a link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const t = loadTs('src/shared/ticketSources.ts');
const { parseLocalWorkPath } = loadTs('src/shared/project.ts');
const { readRoomTickets, readZetahubTable, readLocalTable, zetahubCacheDir } = loadTs('src/main/projectTickets.ts');

const line = (o) => JSON.stringify(o);
const noLog = () => {};

// ─── pure rules ──────────────────────────────────────────────────────────────

test('cache stem and display key follow the cache script', () => {
  assert.equal(t.cacheFileStem('MCX-ANDR'), 'MCXANDR');
  assert.equal(t.cacheFileStem('mdm'), 'MDM');
  assert.equal(t.displayTicketKey('MDM--51'), 'MDM-51');
  assert.equal(t.displayTicketKey('STAND-7'), 'STAND-7');
});

test('rows: closed dropped, sorted by status, priority, number; names resolved', () => {
  const tasks = [
    line({ key: 'MDM--9', title: 'done', status: 'Done', priority: 'High' }),
    line({ key: 'MDM--3', title: 'todo low', status: 'To Do', priority: 'Low' }),
    line({ key: 'MDM--12', title: 'todo high b', status: 'To Do', priority: 'High' }),
    line({ key: 'MDM--2', title: 'todo high a', status: 'To Do', priority: 'High', assignee_id: 'u1', milestone_id: 'm1' }),
    line({ key: 'MDM--20', title: 'review', status: 'Ready for testing', priority: 'Medium' }),
    line({ key: 'MDM--30', title: 'doing', status: 'In Progress', priority: 'Low' }),
    line({ key: 'MDM--40', title: 'blocked', status: 'Blocked', priority: 'Critical' }),
    line({ key: 'MDM--41', title: 'cancelled', status: 'Canceled' }),
    'broken {',
    line({ title: 'no key', status: 'To Do' })
  ].join('\n');
  const people = t.parseLabelMap(line({ id: 'u1', name: 'Ana' }), 'name');
  const milestones = t.parseLabelMap(line({ id: 'm1', title: 'Phase 0' }), 'title');
  const res = t.parseZetahubRows(tasks, people, milestones);
  assert.deepEqual(res.items.map((r) => r.key), ['MDM-30', 'MDM-20', 'MDM-2', 'MDM-12', 'MDM-3', 'MDM-40']);
  assert.equal(res.total, 6);
  assert.equal(res.items[2].assignee, 'Ana');
  assert.equal(res.items[2].milestone, 'Phase 0');
  assert.equal(res.items[0].assignee, null);
});

test('rows: untrusted text is cleaned and capped', () => {
  const res = t.parseZetahubRows(line({ key: 'A-1', title: `evil‮${'x'.repeat(400)}`, status: 'To Do', type: 'T\u0000ask' }), new Map(), new Map());
  assert.equal(res.items[0].title.length, 160);
  assert.ok(!res.items[0].title.includes('‮'));
  assert.equal(res.items[0].type, 'T ask');
});

test('rows: the limit cuts items but total counts all open rows', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => line({ key: `A-${i}`, title: 't', status: 'To Do' })).join('\n');
  const res = t.parseZetahubRows(tasks, new Map(), new Map(), 2);
  assert.equal(res.items.length, 2);
  assert.equal(res.total, 5);
});

test('local path line: needs back-ticks (parsed at project scan)', () => {
  assert.equal(parseLocalWorkPath('Local open work: `docs/in-progress.md`'), 'docs/in-progress.md');
  assert.equal(parseLocalWorkPath('local open work = `notes/todo.md`'), 'notes/todo.md');
  assert.equal(parseLocalWorkPath('Local open work: docs/in-progress.md'), null);
  assert.equal(parseLocalWorkPath(null), null);
});

test('local items: only the "No ticket yet" section, with HIGH flag and source', () => {
  const md = [
    '# In progress',
    '## No ticket yet',
    'Intro paragraph is not an item.',
    '',
    '- First item, then more (review, 2026-11-19)',
    '- HIGH: urgent thing (security audit, 2026-11-19)',
    '  continued on the next line',
    '* Star bullet with no source',
    '## Open work',
    '- not in the section'
  ].join('\r\n');
  const res = t.parseLocalItems(md);
  assert.equal(res.total, 3);
  assert.deepEqual(res.items[0], { text: 'First item, then more', source: 'review, 2026-11-19', high: false });
  assert.equal(res.items[1].high, true);
  assert.equal(res.items[1].text, 'urgent thing (security audit, 2026-11-19) continued on the next line');
  assert.equal(res.items[2].source, null);
});

test('local items: a file without the section gives none', () => {
  assert.deepEqual(t.parseLocalItems('# Title\n- a\n## Other\n- b\n'), { items: [], total: 0 });
});

// ─── readers on temp folders ────────────────────────────────────────────────

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cache() {
  const dir = tempDir('zh-cache-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.mkdirSync(path.join(dir, 'milestones'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ synced_at: '2026-11-20T09:53:36Z' }));
  fs.writeFileSync(path.join(dir, 'people.jsonl'), line({ id: 'u1', name: 'Ana' }));
  fs.writeFileSync(path.join(dir, 'tasks', 'MCXANDR.jsonl'), line({ key: 'MCX-ANDR-4', title: 'x', status: 'To Do', assignee_id: 'u1' }));
  return dir;
}

test('zetahub table: no key, no cache, project not cached, and a good read', async () => {
  const dir = cache();
  assert.deepEqual(await readZetahubTable(null, dir, noLog), { ok: false, key: null, reason: 'no-key' });
  assert.equal((await readZetahubTable('MDM', path.join(dir, 'missing'), noLog)).reason, 'no-cache');
  assert.equal((await readZetahubTable('MDM', dir, noLog)).reason, 'not-cached');
  const ok = await readZetahubTable('MCX-ANDR', dir, noLog);
  assert.equal(ok.ok, true);
  assert.equal(ok.syncedAt, '2026-11-20T09:53:36Z');
  assert.equal(ok.rows[0].assignee, 'Ana');
});

test('cache dir: env only when local absolute, else ~/.claude/cache/zetahub', () => {
  const home = path.resolve('/home/me');
  const fallback = path.join(home, '.claude', 'cache', 'zetahub');
  assert.equal(zetahubCacheDir({}, home), fallback);
  assert.equal(zetahubCacheDir({ ZETAHUB_CACHE: '\\\\server\\share' }, home), fallback);
  assert.equal(zetahubCacheDir({ ZETAHUB_CACHE: 'relative' }, home), fallback);
  const abs = path.resolve('/tmp/zh');
  assert.equal(zetahubCacheDir({ ZETAHUB_CACHE: abs }, home), abs);
});

function project() {
  const root = tempDir('room-proj-');
  const dir = path.join(root, 'proj');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.md'), '## No ticket yet\n- leaked\n');
  fs.writeFileSync(path.join(dir, 'docs', 'open.md'), '## No ticket yet\n- item one (src, 2026-11-20)\n');
  return { root, dir };
}

test('local table: the echoed path is cleaned', async () => {
  const { dir } = project();
  fs.writeFileSync(path.join(dir, 'docs', 'a\u202eb.md'), '## No ticket yet\n- x\n');
  const res = await readLocalTable(dir, 'docs/a\u202eb.md', noLog);
  assert.equal(res.ok, true);
  assert.equal(res.path, 'docs/a b.md');
});

test('local table: reads the named file', async () => {
  const { dir } = project();
  assert.deepEqual(await readLocalTable(dir, null, noLog), { ok: false, reason: 'no-line' });
  const ok = await readLocalTable(dir, 'docs/open.md', noLog);
  assert.equal(ok.ok, true);
  assert.equal(ok.path, 'docs/open.md');
  assert.equal(ok.items[0].text, 'item one');
});

test('local table: outside paths and missing files give the same answer', async () => {
  const { root, dir } = project();
  const unavailable = { ok: false, reason: 'unavailable' };
  assert.deepEqual(await readLocalTable(dir, '../secret.md', noLog), unavailable);
  assert.deepEqual(await readLocalTable(dir, path.join(root, 'secret.md'), noLog), unavailable);
  assert.deepEqual(await readLocalTable(dir, '\\\\server\\share\\x.md', noLog), unavailable);
  assert.deepEqual(await readLocalTable(dir, 'docs/none.md', noLog), unavailable);
  assert.deepEqual(await readLocalTable(dir, '.', noLog), unavailable);
  assert.deepEqual(await readLocalTable(dir, 'docs', noLog), unavailable);
});

test('local table: a link inside the project is refused, not followed', async (t2) => {
  const { root, dir } = project();
  try {
    // A junction needs no admin rights on Windows; elsewhere it is a plain dir link.
    fs.symlinkSync(root, path.join(dir, 'up'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    t2.skip(`cannot create a link here: ${e.code}`);
    return;
  }
  assert.deepEqual(await readLocalTable(dir, 'up/secret.md', noLog), { ok: false, reason: 'unavailable' });
});

test('local table: a file over the size cap is not read', async () => {
  const { dir } = project();
  fs.writeFileSync(path.join(dir, 'docs', 'big.md'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  assert.deepEqual(await readLocalTable(dir, 'docs/big.md', noLog), { ok: false, reason: 'unreadable' });
});

test('local table: a file link as the last segment is refused, not followed', async (t2) => {
  const { root, dir } = project();
  try {
    fs.symlinkSync(path.join(root, 'secret.md'), path.join(dir, 'docs', 'link.md'), 'file');
  } catch (e) {
    t2.skip(`cannot create a file link here: ${e.code}`);
    return;
  }
  assert.deepEqual(await readLocalTable(dir, 'docs/link.md', noLog), { ok: false, reason: 'unavailable' });
});

test('room tickets: a hidden ZetaHub section reads no cache; auto follows the key', async () => {
  const dir = cache();
  const { dir: proj } = project();
  const base = { path: proj, zetahubKey: 'MCX-ANDR', localWorkPath: 'docs/open.md' };
  const hidden = await readRoomTickets({ ...base, showZetahub: false }, noLog, dir);
  assert.deepEqual(hidden.zetahub, { ok: false, key: 'MCX-ANDR', reason: 'hidden' });
  assert.equal(hidden.local.ok, true, 'local items are still read');
  assert.equal((await readRoomTickets({ ...base, showZetahub: null }, noLog, dir)).zetahub.ok, true);
  const localOnly = await readRoomTickets({ ...base, zetahubKey: null, showZetahub: null }, noLog, dir);
  assert.equal(localOnly.zetahub.reason, 'hidden', 'no key and no choice: a local-only project shows no ZetaHub');
  const forced = await readRoomTickets({ ...base, zetahubKey: null, showZetahub: true }, noLog, dir);
  assert.equal(forced.zetahub.reason, 'no-key', 'turned on without a key: the hint says why it is empty');
});

test('room tickets: a key from CLAUDE.md is a suggestion and reads no cache (ADR 0010)', async () => {
  const dir = cache();
  const { dir: proj } = project();
  const base = { path: proj, zetahubKey: 'MCX-ANDR', localWorkPath: 'docs/open.md', showZetahub: null };
  const suggested = await readRoomTickets({ ...base, zetahubKeySource: 'claude-md' }, noLog, dir);
  assert.deepEqual(suggested.zetahub, { ok: false, key: 'MCX-ANDR', reason: 'suggested' });
  assert.equal(suggested.local.ok, true, 'local items are still read');
  const own = await readRoomTickets({ ...base, zetahubKeySource: 'user' }, noLog, dir);
  assert.equal(own.zetahub.ok, true, 'the same key saved by the person is read');
  const hidden = await readRoomTickets({ ...base, zetahubKeySource: 'claude-md', showZetahub: false }, noLog, dir);
  assert.equal(hidden.zetahub.reason, 'hidden', 'a hidden section stays hidden');
});

test('room tickets: a suggested key never touches the cache folder', async () => {
  const { dir: proj } = project();
  const missing = path.join(tempDir('zh-none-'), 'not-there');
  const res = await readRoomTickets(
    { path: proj, zetahubKey: 'MDM', zetahubKeySource: 'claude-md', localWorkPath: null, showZetahub: true },
    () => assert.fail('nothing to log: no cache file is opened'),
    missing
  );
  assert.equal(res.zetahub.reason, 'suggested', 'not no-cache: the cache was not looked at');
});
