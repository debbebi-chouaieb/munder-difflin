'use strict';

// Project room session list (ADR 0005): titles and context size from the
// transcript head and tail, the 10 most recent sessions, UUID ids only, a large
// session that fails closed, and re-reads only when a file changed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const s = loadTs('src/shared/sessionList.ts');
const { cleanText } = loadTs('src/shared/untrustedText.ts');
const { SessionLister } = loadTs('src/main/projectSessions.ts');

const line = (o) => JSON.stringify(o);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ─── pure rules ──────────────────────────────────────────────────────────────

test('head: skips meta, command wrappers, tool results and sidechains', () => {
  const text = [
    line({ type: 'mode', mode: 'x' }),
    line({ type: 'attachment', timestamp: '2026-11-20T08:00:00Z' }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta text' } }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
    line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'agent prompt' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  fix the   login bug ' }] } }),
    '{"type":"user","message":{"content":"cut'
  ].join('\n');
  const head = s.parseSessionHead(text);
  assert.equal(head.firstPrompt, 'fix the   login bug');
  assert.equal(head.startedAt, '2026-11-20T08:00:00Z');
});

test('head: no real prompt in the window gives null, not an error', () => {
  assert.deepEqual(s.parseSessionHead('not json\n{"type":"user","isMeta":true}'), { firstPrompt: null, startedAt: null });
});

test('tail: last ai-title wins, custom title beats it, context is the last assistant usage', () => {
  const tail = [
    line({ type: 'ai-title', aiTitle: 'Old title' }),
    line({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    line({ type: 'custom-title', customTitle: 'My name' }),
    line({ type: 'ai-title', aiTitle: 'New   title' }),
    line({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 2 } } }),
    line({ type: 'assistant', message: {} }),
    'partial {"type":"ai-title"'
  ].join('\n');
  assert.deepEqual(s.parseSessionTail(tail), { customTitle: 'My name', aiTitle: 'New title', contextTokens: 117 });
});

test('tail: a synthetic all-zero usage record is not a context reading', () => {
  const tail = [
    line({ type: 'assistant', message: { usage: { input_tokens: 150_000 } } }),
    line({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } })
  ].join('\n');
  assert.equal(s.parseSessionTail(tail).contextTokens, 150_000);
  const onlySynthetic = line({ type: 'assistant', message: { usage: { input_tokens: 0 } } });
  assert.equal(s.parseSessionTail(onlySynthetic).contextTokens, null);
});

test('title falls back from custom to ai to first prompt to a short id', () => {
  const head = { firstPrompt: 'first prompt', startedAt: null };
  const id = uuid(1);
  assert.equal(s.sessionTitle(id, head, { customTitle: 'C', aiTitle: 'A' }), 'C');
  assert.equal(s.sessionTitle(id, head, { customTitle: null, aiTitle: 'A' }), 'A');
  assert.equal(s.sessionTitle(id, head, { customTitle: null, aiTitle: null }), 'first prompt');
  assert.equal(s.sessionTitle(id, { firstPrompt: null, startedAt: null }, { customTitle: null, aiTitle: null }), 'Session 00000000');
});

test('untrusted text: one line, no control or bidi override characters, capped', () => {
  assert.equal(cleanText('a\u202eb\u0007c\nd', 50), 'a b c d');
  assert.equal(cleanText('x'.repeat(300), 120).length, 120);
  assert.ok(cleanText('x'.repeat(300), 120).endsWith('…'));
  assert.equal(cleanText('\u2066\u2069  ', 10), null);
  assert.equal(cleanText(42, 10), null);
  assert.equal(cleanText('a\u200eb\u200fc\u061cd', 50), 'a b c d');
});

test('session ids: UUID only, so no id can look like a flag', () => {
  assert.equal(s.isValidSessionId('7aad2caa-8fa5-43c0-8b7f-55da8021eaa2'), true);
  assert.equal(s.isValidSessionId('--dangerously-skip-permissions'), false);
  assert.equal(s.isValidSessionId('../x'), false);
  assert.equal(s.sessionIdFromFileName('7aad2caa-8fa5-43c0-8b7f-55da8021eaa2.jsonl'), '7aad2caa-8fa5-43c0-8b7f-55da8021eaa2');
  assert.equal(s.sessionIdFromFileName('7aad2caa-8fa5-43c0-8b7f-55da8021eaa2'), null);
  assert.equal(s.sessionIdFromFileName('notes.jsonl'), null);
});

test('recent: newest first, capped at 10, extra fields kept', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, mtimeMs: i, size: i * 10 }));
  const picked = s.pickRecentSessions(entries);
  assert.equal(picked.length, 10);
  assert.equal(picked[0].id, 's14');
  assert.equal(picked[0].size, 140);
  assert.equal(picked[9].id, 's5');
});

test('large session: above 100k tokens; unknown size on a file over 1 MB also counts', () => {
  assert.equal(s.isLargeSession(100_000, 0), false);
  assert.equal(s.isLargeSession(100_001, 0), true);
  assert.equal(s.isLargeSession(null, 1024 * 1024), false);
  assert.equal(s.isLargeSession(null, 1024 * 1024 + 1), true);
});

// ─── lister on a temp folder ────────────────────────────────────────────────

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'room-sessions-'));
}

function writeSession(dir, id, { title = `Title ${id}`, tokens = 10, mtimeSec = 1_700_000_000 } = {}) {
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, [
    line({ type: 'user', timestamp: '2026-11-20T08:00:00Z', message: { role: 'user', content: 'prompt' } }),
    line({ type: 'ai-title', aiTitle: title }),
    line({ type: 'assistant', message: { usage: { input_tokens: tokens } } })
  ].join('\n'));
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function lister(dir, over = {}) {
  const logs = [];
  const l = new SessionLister({ dirFor: () => dir, log: (m) => logs.push(m), reuseMs: 0, ...over });
  return { l, logs };
}

test('lister: missing folder means no sessions', async () => {
  const { l } = lister(path.join(tempDir(), 'none'));
  assert.deepEqual(await l.list('D:/p'), []);
});

test('lister: the 10 newest, other files ignored, titles and tokens read', async () => {
  const dir = tempDir();
  for (let i = 0; i < 12; i++) writeSession(dir, uuid(i), { tokens: i === 11 ? 150_000 : 10, mtimeSec: 1_700_000_000 + i });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '--flag.jsonl'), 'x');
  fs.mkdirSync(path.join(dir, `${uuid(99)}.jsonl`));
  const { l } = lister(dir);
  const list = await l.list('D:/p');
  assert.equal(list.length, 10);
  assert.equal(list[0].id, uuid(11));
  assert.equal(list[0].title, `Title ${uuid(11)}`);
  assert.equal(list[0].contextTokens, 150_000);
  assert.equal(list[0].large, true);
  assert.equal(list[1].large, false);
});

test('lister: an unchanged file comes from cache; a changed one is read again', async () => {
  const dir = tempDir();
  const file = writeSession(dir, uuid(1));
  const { l } = lister(dir);
  const first = await l.list('D:/p');
  const second = await l.list('D:/p');
  assert.equal(second[0], first[0]);
  fs.appendFileSync(file, `\n${line({ type: 'ai-title', aiTitle: 'Renamed' })}`);
  fs.utimesSync(file, 1_700_000_100, 1_700_000_100);
  const [after] = await l.list('D:/p');
  assert.notEqual(after, first[0]);
  assert.equal(after.title, 'Renamed');
});

test('lister: calls within the reuse window share one read', async () => {
  const dir = tempDir();
  writeSession(dir, uuid(1));
  let now = 1000;
  const { l } = lister(dir, { reuseMs: 2000, now: () => now });
  const a = l.list('D:/p');
  const b = l.list('D:/p');
  assert.equal(a, b);
  now += 2500;
  assert.notEqual(l.list('D:/p'), a);
});

test('lister: cache keeps the most recently used entries within its cap', async () => {
  const dir = tempDir();
  for (let i = 0; i < 3; i++) writeSession(dir, uuid(i), { mtimeSec: 1_700_000_000 + i });
  const { l } = lister(dir, { maxCacheEntries: 2 });
  const s0 = await l.summaryOf('D:/p', uuid(0));
  await l.summaryOf('D:/p', uuid(1));
  assert.equal(await l.summaryOf('D:/p', uuid(0)), s0); // hit: 0 becomes most recent
  await l.summaryOf('D:/p', uuid(2)); // evicts 1, not 0
  assert.equal(await l.summaryOf('D:/p', uuid(0)), s0);
});

test('lister: summaryOf refuses bad and unknown ids', async () => {
  const dir = tempDir();
  writeSession(dir, uuid(1));
  const { l } = lister(dir);
  assert.equal((await l.summaryOf('D:/p', uuid(1))).id, uuid(1));
  assert.equal(await l.summaryOf('D:/p', uuid(2)), null);
  assert.equal(await l.summaryOf('D:/p', '..\\x'), null);
});
