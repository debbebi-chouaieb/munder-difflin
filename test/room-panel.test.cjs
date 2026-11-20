'use strict';

// Project room panel (ADR 0005, ADR 0006): the open flow asks before trusting a
// project (and binds the answer to the folder shown) and before resuming a large
// session; every error code has a string in every language; ticket text renders
// as text only; the right panel shows a room or an agent; each project room is a
// click target with two count boards that redraw only when a count changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const model = loadTs('src/renderer/src/components/room/roomPanelModel.ts');
const counts = loadTs('src/renderer/src/store/roomBoardCounts.ts');
const cork = loadTs('src/renderer/src/scene/office/corkBoard.ts');
const { RoomBoards } = loadTs('src/renderer/src/scene/office/RoomBoards.ts');
const { ROOM_ERROR_CODES } = loadTs('src/shared/roomLead.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ar', 'zh-CN'].map((code) => [code, JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`))]);
const ROOM_DIR = 'src/renderer/src/components/room';
const roomSources = fs.readdirSync(path.join(ROOT, ROOM_DIR)).map((f) => [f, read(`${ROOM_DIR}/${f}`)]);
const ABC = '00000000-0000-4000-8000-000000000abc';

function lookup(tree, key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);
}

// ── open flow ────────────────────────────────────────────────────────────────

test('an opened lead is shown; a "Trust" that did not stick is reported', () => {
  const opened = { ok: true, agentId: 'lead--app', alreadyRunning: false, untrusted: false };
  assert.deepEqual(model.openStep({ sessionId: null }, opened), { kind: 'opened', agentId: 'lead--app', trustNotSaved: false });
  const unsaved = { ...opened, untrusted: true };
  assert.equal(model.openStep({ trust: 'yes', trustPath: 'D:/ws/App' }, unsaved).trustNotSaved, true);
  assert.equal(model.openStep({ trust: 'no' }, unsaved).trustNotSaved, false, '"no" is meant to be untrusted');
});

test('needs-trust asks about the folder main named, keeping the request', () => {
  const request = { sessionId: ABC };
  assert.deepEqual(model.openStep(request, { ok: false, error: 'needs-trust', path: 'D:/ws/App', claudeTrusts: true }),
    { kind: 'ask-trust', request, path: 'D:/ws/App', claudeTrusts: true });
});

test('large-session asks before resuming and carries the size, even when unknown', () => {
  const request = { sessionId: ABC };
  assert.deepEqual(model.openStep(request, { ok: false, error: 'large-session', contextTokens: 150000 }),
    { kind: 'confirm-large', request, contextTokens: 150000 });
  assert.equal(model.openStep(request, { ok: false, error: 'large-session', contextTokens: null }).contextTokens, null);
});

test('every other failure becomes a translated message', () => {
  assert.deepEqual(model.openStep({}, { ok: false, error: 'spawn-failed' }), { kind: 'failed', errorKey: 'room.errors.spawn-failed' });
});

test('"Trust" sends back the folder the dialog showed; "Open without trust" sends none', () => {
  const request = { sessionId: ABC, confirmLarge: true };
  assert.deepEqual(model.withTrust(request, 'yes', 'D:/ws/App'), { ...request, trust: 'yes', trustPath: 'D:/ws/App' });
  assert.deepEqual(model.withTrust({ ...request, trust: 'yes', trustPath: 'D:/ws/Old' }, 'no', 'D:/ws/App'), { ...request, trust: 'no' });
  assert.deepEqual(request, { sessionId: ABC, confirmLarge: true }, 'input untouched');
});

test('"resume anyway" confirms the large session; "new session" drops it and keeps the trust answer', () => {
  const request = { sessionId: ABC, trust: 'yes', trustPath: 'D:/ws/App' };
  assert.deepEqual(model.afterLargeAnswer(request, 'resume'), { ...request, confirmLarge: true });
  assert.deepEqual(model.afterLargeAnswer(request, 'new'), { sessionId: null, confirmLarge: false, trust: 'yes', trustPath: 'D:/ws/App' });
});

test('a read that main refused shows its code; a rejected call is logged and shows a read failure', () => {
  const logs = [];
  const log = (l) => logs.push(l);
  assert.equal(model.readErrorKey('x', { status: 'fulfilled', value: { ok: true, sessions: [] } }, log), null);
  assert.equal(model.readErrorKey('x', { status: 'fulfilled', value: { ok: false, error: 'unknown-project' } }, log), 'room.errors.unknown-project');
  assert.deepEqual(logs, []);
  assert.equal(model.readErrorKey('sessions of app', { status: 'rejected', reason: new Error('ipc gone') }, log), 'room.errors.read-failed');
  assert.deepEqual(logs, ['[room] sessions of app failed: ipc gone']);
});

// ── right panel ──────────────────────────────────────────────────────────────

test('a selected room wins over the selected agent', () => {
  assert.equal(model.rightPanelView('app', true), 'room');
  assert.equal(model.rightPanelView(null, true), 'agent');
  assert.equal(model.rightPanelView(null, false), 'none');
});

test('App mounts one room panel per room, so a late answer cannot reach another room', () => {
  assert.match(read('src/renderer/src/App.tsx'), /<RoomPanel key=\{selectedRoomId\} projectId=\{selectedRoomId\} \/>/);
});

test('selecting an agent closes the room', () => {
  const store = read('src/renderer/src/store/store.ts');
  const start = store.indexOf('  select: (id) => {');
  const select = store.slice(start, store.indexOf('  updateAgent: (id, patch) =>', start));
  assert.ok(start > 0 && select.length > 0, 'select implementation found');
  assert.match(select, /useRoomPanel\.getState\(\)\.clearRoom\(\)/);
});

// ── strings ──────────────────────────────────────────────────────────────────

test('every room error code has a string in every language', () => {
  assert.equal(new Set(ROOM_ERROR_CODES).size, ROOM_ERROR_CODES.length);
  for (const [code, tree] of LOCALES) {
    for (const err of ROOM_ERROR_CODES) assert.equal(typeof lookup(tree, model.roomErrorKey(err)), 'string', `${code}: ${err}`);
  }
});

test('every room string the panel uses exists in every language', () => {
  const keys = new Set(['queueComposer.heldTrust', 'room.trust.notSaved']);
  for (const [, src] of roomSources) for (const m of src.matchAll(/\bt\('((?:room|agentDetail)\.[\w.-]+)'/g)) keys.add(m[1]);
  // Keys built from a reason: the reasons ZetahubTable and LocalTable allow (src/shared/ticketSources.ts).
  for (const r of ['no-key', 'no-cache', 'not-cached', 'unreadable']) keys.add(`room.tickets.zetahubReason.${r}`);
  for (const r of ['no-line', 'unavailable', 'unreadable']) keys.add(`room.tickets.localReason.${r}`);
  for (const k of ['untrusted', 'untrustedButClaudeTrusts']) keys.add(`room.trust.${k}`);
  assert.ok(keys.size > 40, `found ${keys.size} keys`);
  for (const [code, tree] of LOCALES) {
    for (const key of keys) assert.equal(typeof lookup(tree, key), 'string', `${code}: ${key}`);
  }
});

// ── text only ────────────────────────────────────────────────────────────────

test('ticket, session and project text is never rendered as HTML or markdown', () => {
  for (const [file, src] of roomSources) {
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML|react-markdown|<Trans\b|marked\(/, file);
  }
});

test('the composer names the trust hold ahead of the terminal holds', () => {
  const composer = read('src/renderer/src/components/MessageQueueComposer.tsx');
  const trust = composer.indexOf("t('queueComposer.heldTrust'");
  assert.ok(trust > 0 && trust < composer.indexOf("t('queueComposer.heldDraft'"));
});

// ── formatting ───────────────────────────────────────────────────────────────

test('context sizes read as the list shows them, around the 100k warning', () => {
  assert.equal(model.formatTokens(999), '999');
  assert.equal(model.formatTokens(1000), '1k');
  assert.equal(model.formatTokens(12_340), '12.3k');
  assert.equal(model.formatTokens(99_949), '99.9k');
  assert.equal(model.formatTokens(100_000), '100k');
  assert.equal(model.formatTokens(150_400), '150k');
});

test('Stop disposes the lead\'s pooled terminal after a successful close, so a reopen starts clean', () => {
  const panel = read(`${ROOM_DIR}/RoomPanel.tsx`);
  const stop = panel.slice(panel.indexOf('const stop = async'), panel.indexOf('const answer ='));
  const close = stop.indexOf('roomCloseTerminal');
  const dispose = stop.indexOf('disposeTerminal(ptyId)');
  assert.ok(close > 0 && dispose > close, 'dispose comes after the close');
  assert.ok(stop.indexOf('if (!res.ok)') < dispose, 'and only on the success branch');
});

test('the cache time is localized; text that is not a date is shown as it is', () => {
  assert.equal(model.formatSyncedAt('not a date', 'en'), 'not a date');
  assert.notEqual(model.formatSyncedAt('2026-11-20T10:00:00Z', 'en'), '2026-11-20T10:00:00Z');
});

// ── count boards ─────────────────────────────────────────────────────────────

test('board counts come from each source, null when it is not set up', () => {
  const tickets = { zetahub: { ok: true, key: 'APP', rows: [], total: 7, syncedAt: null }, local: { ok: false, reason: 'no-line' } };
  assert.deepEqual(counts.boardCounts(tickets), { zetahub: 7, local: null });
  assert.equal(counts.sameBoardCounts({ zetahub: 7, local: null }, { zetahub: 7, local: null }), true);
  assert.equal(counts.sameBoardCounts(undefined, { zetahub: 0, local: 0 }), false);
});

test('room store: unchanged counts keep the same object; a failed read keeps the old count and is logged', async () => {
  const { useRoomPanel } = loadTs('src/renderer/src/store/roomPanel.ts');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (l) => warnings.push(l);
  const answers = {
    app: { ok: true, tickets: { zetahub: { ok: true, key: 'APP', rows: [], total: 2, syncedAt: null }, local: { ok: true, path: 'x', items: [], total: 1 } } },
    web: { ok: false, error: 'unknown-project' }
  };
  globalThis.window = { cth: { roomTickets: async (id) => { if (id === 'boom') throw new Error('ipc gone'); return answers[id]; } } };
  try {
    const st = useRoomPanel.getState();
    st.setCounts('web', { zetahub: 5, local: null });
    await st.refreshCounts(['app', 'web', 'boom']);
    const after = useRoomPanel.getState().counts;
    assert.deepEqual(after.app, { zetahub: 2, local: 1 });
    assert.deepEqual(after.web, { zetahub: 5, local: null }, 'refused read keeps the old count');
    assert.equal(warnings.length, 2);
    await useRoomPanel.getState().refreshCounts(['app']);
    assert.equal(useRoomPanel.getState().counts, after, 'same counts: same object, no floor redraw');
    useRoomPanel.getState().selectRoom('app');
    useRoomPanel.getState().clearRoom();
    assert.equal(useRoomPanel.getState().selectedRoomId, null);
  } finally {
    console.warn = realWarn;
    delete globalThis.window;
  }
});

test('a count draws one note per item, then one more for the overflow pile', () => {
  assert.deepEqual(cork.countNotes(null, 1), []);
  assert.deepEqual(cork.countNotes(0, 1), []);
  assert.equal(cork.countNotes(3, 1).length, 3);
  assert.equal(cork.countNotes(cork.CORK_NOTES, 1).length, cork.CORK_NOTES);
  assert.equal(cork.countNotes(500, 1).length, cork.CORK_NOTES + 1);
});

test('drawCork paints frame, header, cork and one note plus pin per note, and a pile past the limit', () => {
  const rects = [];
  const g = { rect: (...r) => { rects.push(r); return { fill: () => {} }; } };
  cork.drawCork(g, 0, 0xff0000, [1, 2]);
  assert.equal(rects.length, 3 + 2 * 2);
  rects.length = 0;
  cork.drawCork(g, 0, 0xff0000, cork.countNotes(99, 1));
  assert.equal(rects.length, 3 + cork.CORK_NOTES * 2 + 2);
});

test('room boards hang on the top wall at the right, clear of the name at the left', () => {
  const rect = { x: 2, y: 5, width: 13, height: 8 };
  const o = cork.roomBoardsOrigin(rect, 16);
  assert.equal(o.y, 4 * 16, 'the wall row above the interior');
  assert.ok(o.x + cork.ROOM_BOARDS_W <= (rect.x + rect.width) * 16, 'inside the right edge');
  assert.ok(o.x >= rect.x * 16 + 64, 'leaves room for the label');
});

function fakeGraphics() {
  const g = {
    handlers: {}, rects: 0, clears: 0, position: { set(x, y) { g.x = x; g.y = y; } },
    on(ev, fn) { g.handlers[ev] = fn; return g; },
    clear() { g.clears++; g.rects = 0; return g; },
    rect() { g.rects++; return { fill: () => {} }; }
  };
  return g;
}

function fakeCounts(initial) {
  let state = { counts: initial };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { const prev = state; state = { counts: next }; for (const fn of listeners) fn(state, prev); },
    listeners
  };
}

test('RoomBoards: a project room is a click target under the agents; boards redraw only on a count change', () => {
  const rooms = [
    { id: 'app', kind: 'project', label: 'App', rect: { x: 2, y: 5, width: 13, height: 8 }, seatNames: [], labelTile: { x: 2, y: 4 } },
    { id: 'cafe', kind: 'cafe', label: 'Cafe', rect: { x: 20, y: 5, width: 13, height: 8 }, seatNames: [], labelTile: { x: 20, y: 4 } }
  ];
  const made = [];
  const picked = [];
  const store = fakeCounts({ app: { zetahub: 3, local: null } });
  const boards = new RoomBoards({
    rooms, tileSize: 16, colors: { zetahub: 1, local: 2 },
    makeGraphics: () => { const g = fakeGraphics(); made.push(g); return g; },
    addChild: () => {}, onPick: (id) => picked.push(id), counts: store
  });
  assert.equal(made.length, 2, 'hit area and boards for the project room only, none for the café');
  const [hit, board] = made;
  assert.equal(hit.zIndex, -1, 'below the characters, so an agent click stays the agent\'s');
  assert.equal(hit.hitArea.contains(2 * 16, 5 * 16), true);
  assert.equal(hit.hitArea.contains(15 * 16, 5 * 16), false);
  let stopped = false;
  hit.handlers.pointertap({ stopPropagation: () => { stopped = true; } });
  board.handlers.pointertap({ stopPropagation: () => {} });
  assert.deepEqual(picked, ['app', 'app']);
  assert.equal(stopped, true);
  assert.equal(board.rects, 3 + 3 * 2 + 3, 'ZetaHub board with 3 notes, empty local board');
  const clears = board.clears;
  store.set(store.getState().counts); // same object: no change
  assert.equal(board.clears, clears);
  store.set({ app: { zetahub: 0, local: 4 } });
  assert.equal(board.clears, clears + 1);
  boards.destroy();
  assert.equal(store.listeners.size, 0, 'destroy unsubscribes');
});

test('the floor destroys the room boards with the scene and keeps counts fresh', () => {
  const floor = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(floor, /\(a as any\)\.__roomBoards\?\.destroy\(\)/);
  assert.match(floor, /useRoomBoardCounts\(projectFloor\.active\)/);
});
