'use strict';

// Left project sidebar (ADR 0001, Phase 2). The pure rules are loaded directly;
// the React components are checked by reading their source, the house pattern
// for TSX in this repo (see settings-one-save.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const sidebar = loadTs('src/renderer/src/store/projectSidebar.ts');
const shared = loadTs('src/shared/project.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const projects = [
  { id: 'mcx', path: 'D:\\zetabox\\mcx' },
  { id: 'mdm-platform', path: 'D:\\zetabox\\mdm-platform' }
];

test('width is clamped to 200-400 and defaults to 260', () => {
  assert.equal(sidebar.clampProjectSidebarWidth(100), 200);
  assert.equal(sidebar.clampProjectSidebarWidth(999), 400);
  assert.equal(sidebar.clampProjectSidebarWidth(287.6), 288);
  assert.equal(sidebar.clampProjectSidebarWidth(Number.NaN), 260);
});

test('an agent cwd maps to its project, case-insensitively, not to a sibling', () => {
  assert.equal(shared.projectIdForCwd('d:/zetabox/mcx/platform', projects), 'mcx');
  assert.equal(shared.projectIdForCwd('D:\\zetabox\\mdm-platform\\', projects), 'mdm-platform');
  assert.equal(shared.projectIdForCwd('D:\\zetabox\\mcx-old', projects), null);
  assert.equal(shared.projectIdForCwd('', projects), null);
});

test('agents are grouped into the CEO and their projects', () => {
  const agents = [
    { id: 'god', name: 'Michael', cwd: 'C:\\hive', isGod: true },
    { id: 'prep', name: 'Pam', cwd: 'C:\\hive', isAssistant: true },
    { id: 'a1', name: 'sdk-dev', cwd: 'D:\\zetabox\\mcx' },
    { id: 'a2', name: 'tester', cwd: 'D:\\zetabox\\mcx\\platform' },
    { id: 'a3', name: 'old', cwd: 'D:\\zetabox\\mcx', archived: true },
    { id: 'a4', name: 'go-dev', cwd: 'D:\\zetabox\\mdm-platform' },
    { id: 'a5', name: 'elsewhere', cwd: 'C:\\tmp' }
  ];
  const groups = sidebar.groupAgents(agents, projects);
  assert.equal(groups.ceo.id, 'god');
  assert.deepEqual(groups.byProject.mcx.map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(groups.byProject['mdm-platform'].map((a) => a.id), ['a4']);
  assert.equal(Object.keys(groups.byProject).length, 2, 'the assistant and outside agents are not listed');
});

test('the workspace label is the last folder name', () => {
  assert.equal(sidebar.workspaceLabel('D:\\zetabox\\'), 'zetabox');
  assert.equal(sidebar.workspaceLabel('/home/me/work'), 'work');
  assert.equal(sidebar.workspaceLabel(null), '');
});

test('hidden, the sidebar keeps a single icon that only reopens it', () => {
  const src = read('src/renderer/src/components/ProjectSidebar.tsx');
  const collapsed = src.slice(src.indexOf('if (collapsed)'), src.indexOf('return <ExpandedSidebar'));
  assert.equal((collapsed.match(/<PixelButton/g) ?? []).length, 1);
  assert.match(collapsed, /onClick=\{\(\) => setCollapsed\(false\)\}/);
});

test('drag direction: a panel grows when its handle is dragged into the floor, mirrored in RTL', () => {
  const { dragSign } = loadTs('src/renderer/src/components/splitterRules.ts');
  assert.equal(dragSign('right', false), -1);
  assert.equal(dragSign('right', true), 1, 'in RTL the agent panel is drawn on the left');
  assert.equal(dragSign('left', false), 1);
  assert.equal(dragSign('left', true), -1);
});

test('two sidebars can never squeeze the floor below its minimum', () => {
  const { nextPanelWidth, MIN_FLOOR_WIDTH } = loadTs('src/renderer/src/components/splitterRules.ts');
  // 1280 px window, agent sidebar 920 px: the project panel may only use what is left.
  const available = 1280 - 920;
  const width = nextPanelWidth({ startWidth: 260, dragPx: 500, sign: 1, min: 200, max: 400, availableWidth: available });
  assert.equal(width, 200, 'held at its minimum when nothing is left');
  assert.equal(
    nextPanelWidth({ startWidth: 260, dragPx: 500, sign: 1, min: 200, max: 400, availableWidth: 1280 }),
    400
  );
  assert.equal(
    nextPanelWidth({ startWidth: 420, dragPx: -100, sign: -1, min: 320, max: 1200, availableWidth: 1280 }),
    520,
    'the agent panel grows on a left drag, as before'
  );
  assert.equal(
    nextPanelWidth({ startWidth: 420, dragPx: -2000, sign: -1, min: 320, max: 1200, availableWidth: 1280 }),
    1280 - MIN_FLOOR_WIDTH
  );
});

test('the key editor saves only real, valid changes', () => {
  assert.equal(sidebar.keyDraftAction('mdm', 'MDM'), 'unchanged', 'a CLAUDE.md key is not turned into a user key');
  assert.equal(sidebar.keyDraftAction('  ', null), 'unchanged');
  assert.equal(sidebar.keyDraftAction('', 'MDM'), 'clear');
  assert.equal(sidebar.keyDraftAction('mcx-andr', 'MCX'), 'save');
  assert.equal(sidebar.keyDraftAction('mdm_1', null), 'invalid');
});

test('known main errors map to translated messages', () => {
  assert.equal(sidebar.projectErrorKey('no hive yet'), 'projectSidebar.errors.noHive');
  assert.equal(sidebar.projectErrorKey('cannot read workspace: ENOENT'), 'projectSidebar.errors.workspaceUnreadable');
  assert.equal(sidebar.projectErrorKey('something new'), null);
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  for (const msg of ['pick a local folder', 'no hive yet', 'invalid ZetaHub key', 'unknown project',
    'projects.json cannot be read', 'projects.json is not valid JSON', 'projects.json is too large',
    'workspace is not a local folder', 'cannot read workspace: EACCES']) {
    const key = sidebar.projectErrorKey(msg);
    const value = key.split('.').reduce((o, k) => o?.[k], en);
    assert.equal(typeof value, 'string', `${key} exists in en.json`);
  }
});

function loadStore(cth, storage = {}) {
  global.window = {
    cth,
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    }
  };
  // A fresh module each time so the store reads this test's window.
  const file = require.resolve('./load-ts.cjs');
  delete require.cache[file];
  return require('./load-ts.cjs')('src/renderer/src/store/projects.ts').useProjects;
}

const okSnapshot = { workspaceRoot: 'D:\\zetabox', projects: [], globalAgents: ['reviewer'] };

test('the store restores width and hidden state, and clamps a bad width', (t) => {
  t.after(() => { delete global.window; });
  const store = loadStore({}, { 'cth.projectSidebarCollapsed': '1', 'cth.projectSidebarWidth': 'oops' });
  assert.equal(store.getState().collapsed, true);
  assert.equal(store.getState().width, 260);
  store.getState().setWidth(999);
  assert.equal(store.getState().width, 400);
  assert.equal(global.window.localStorage.getItem('cth.projectSidebarWidth'), '400');
});

test('the store: cancel clears the error, failures show it, a failed load stays not-loaded', async (t) => {
  t.after(() => { delete global.window; });
  let pickResult = { ok: false, error: 'pick a local folder' };
  const store = loadStore({
    onProjectsChanged: () => () => {},
    listProjects: () => Promise.reject(new Error('ipc down')),
    pickWorkspace: () => Promise.resolve(pickResult),
    setProjectEnabled: () => Promise.reject(new Error('boom'))
  });
  store.getState().connect();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.getState().loaded, false);
  assert.equal(store.getState().actionError, 'ipc down');

  await store.getState().pickWorkspace();
  assert.equal(store.getState().actionError, 'pick a local folder');
  pickResult = { ok: false, error: 'cancelled' };
  await store.getState().pickWorkspace();
  assert.equal(store.getState().actionError, null);

  await store.getState().setEnabled('mcx', true);
  assert.equal(store.getState().actionError, 'boom', 'a thrown IPC call is shown, not lost');

  pickResult = { ok: true, snapshot: okSnapshot };
  await store.getState().pickWorkspace();
  assert.equal(store.getState().loaded, true);
  assert.equal(store.getState().actionError, null);
  assert.deepEqual(store.getState().snapshot, okSnapshot);
});

test('App mounts the project sidebar before the office floor', () => {
  const app = read('src/renderer/src/App.tsx');
  const sidebarAt = app.indexOf('<ProjectSidebar />');
  assert.ok(sidebarAt > 0);
  assert.ok(sidebarAt < app.indexOf('<OfficeFloor />'));
  assert.match(app, /useEffect\(\(\) => useProjects\.getState\(\)\.connect\(\), \[\]\)/);
});
