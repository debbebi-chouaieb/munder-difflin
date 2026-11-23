'use strict';

// PTY output coalescing (ADR 0005, Rooms-d): order kept, nothing lost, sent at
// most every flushMs or at once past maxChars, and flush sends what is pending.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createOutputBatcher, PTY_FLUSH_MS, PTY_FLUSH_MAX_CHARS } = loadTs('src/main/ptyOutputBatcher.ts');

function harness(over = {}) {
  const sent = [];
  const timers = [];
  const b = createOutputBatcher({
    send: (d) => sent.push(d),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    ...over
  });
  const fire = () => timers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn(); });
  return { b, sent, timers, fire };
}

test('defaults follow ADR 0005: about 16 ms or 64 KB', () => {
  assert.equal(PTY_FLUSH_MS, 16);
  assert.equal(PTY_FLUSH_MAX_CHARS, 64 * 1024);
});

test('chunks within one window go out once, joined in order', () => {
  const { b, sent, timers, fire } = harness();
  b.push('a');
  b.push('b');
  b.push('c');
  assert.deepEqual(sent, []);
  assert.equal(timers.length, 1, 'one timer per window');
  assert.equal(timers[0].ms, 16);
  fire();
  assert.deepEqual(sent, ['abc']);
  b.push('d');
  fire();
  assert.deepEqual(sent, ['abc', 'd']);
});

test('past the size cap the batch goes out at once, and its timer is cleared', () => {
  const { b, sent, timers } = harness({ maxChars: 4 });
  b.push('ab');
  b.push('cd');
  assert.deepEqual(sent, ['abcd']);
  assert.equal(timers[0].cleared, true);
  b.push('e'.repeat(10));
  assert.deepEqual(sent, ['abcd', 'eeeeeeeeee'], 'one oversized chunk is sent whole');
});

test('flush sends what is pending, and does nothing when empty', () => {
  const { b, sent, timers } = harness();
  b.flush();
  assert.deepEqual(sent, []);
  b.push('x');
  b.flush();
  assert.deepEqual(sent, ['x']);
  assert.equal(timers[0].cleared, true);
  b.push('');
  b.flush();
  assert.deepEqual(sent, ['x'], 'an empty chunk sends nothing');
});

test('with real timers a burst arrives as one message', async () => {
  const sent = [];
  const b = createOutputBatcher({ send: (d) => sent.push(d), flushMs: 5 });
  for (let i = 0; i < 100; i++) b.push(String(i % 10));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 100);
});

test('wiring: every PTY sends through its batcher, flushed before exit and kill', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  assert.match(src, /session\.output\.push\(data\);/);
  assert.match(src, /session\.output\.flush\(\);\s*this\.safeSend\(`pty:exit:/);
  assert.match(src, /s\.output\.flush\(\);\s*s\.proc\.kill\(\);/);
  assert.equal((src.match(/safeSend\(`pty:data:/g) ?? []).length, 1, 'only the batcher sends pty:data');
});
