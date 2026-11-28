'use strict';

// ADR 0020 ticket 2: what an agent runs and where is main-owned. config:update
// drops those fields; main's own calls ask in a native dialog where a script in
// the renderer could otherwise turn on auto mode or register a folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  MAIN_OWNED_CONFIG_KEYS, withoutMainOwnedConfig, createPickedFolders, createConfigOwner, confirmText, folderKey
} = loadTs('src/main/configOwner.ts');

const ROOT = path.resolve(os.tmpdir(), 'md-owner');
const A = path.join(ROOT, 'A');
const B = path.join(ROOT, 'B');
const C = path.join(ROOT, 'C');

function owner({ config = {}, answer = false, ensure = { ok: true } } = {}) {
  let cfg = { onboardingComplete: true, autoMode: false, orchestratorMaySpawn: false, registeredRepos: [], harnessHome: null, recentHives: [], ...config };
  const calls = { confirm: [], write: [], ensure: [] };
  const picked = createPickedFolders();
  const o = createConfigOwner({
    read: () => cfg,
    write: (patch) => { calls.write.push(patch); cfg = { ...cfg, ...patch }; return cfg; },
    picked,
    expand: (p) => p,
    ensureHome: (p) => { calls.ensure.push(p); return ensure; },
    confirm: async (request, who) => { calls.confirm.push({ request, who }); return answer; }
  });
  return { o, calls, picked, cfg: () => cfg };
}

test('config:update drops every field that decides what an agent runs or where', () => {
  const patch = Object.fromEntries(MAIN_OWNED_CONFIG_KEYS.map((k) => [k, 'x']));
  assert.deepEqual(withoutMainOwnedConfig({ ...patch, telemetryEnabled: true, defaultModel: 'opus' }), { telemetryEnabled: true, defaultModel: 'opus' });
  for (const key of ['workspaceRoot', 'approvedSpawns', 'defaultCommand', 'autoMode', 'orchestratorMaySpawn', 'registeredRepos', 'harnessHome', 'recentHives', 'onboardingComplete']) {
    assert.ok(MAIN_OWNED_CONFIG_KEYS.includes(key), key);
  }
});

test('switches: turning on asks in the asking window, turning off never asks', async () => {
  for (const key of ['autoMode', 'orchestratorMaySpawn']) {
    const set = key === 'autoMode' ? 'setAutoMode' : 'setOrchestratorMaySpawn';
    const no = owner({ answer: false });
    assert.deepEqual(await no.o[set](true, 'win'), { ok: false, error: 'not-confirmed' });
    assert.deepEqual(no.calls.confirm, [{ request: { kind: key }, who: 'win' }]);
    assert.deepEqual(no.calls.write, [], `${key}: a no writes nothing`);

    const yes = owner({ answer: true });
    assert.equal((await yes.o[set](true, 'win')).config[key], true);

    const off = owner({ config: { [key]: true } });
    assert.equal((await off.o[set](false, null)).config[key], false);
    assert.deepEqual(off.calls.confirm, []);

    const already = owner({ config: { [key]: true } });
    assert.equal((await already.o[set](true, null)).ok, true);
    assert.deepEqual(already.calls.confirm, [], `${key}: already on does not ask`);

    assert.deepEqual(await owner().o[set]('yes', null), { ok: false, error: 'invalid-request' });
  }
});

test('repos:add takes a folder picked in the dialog silently and asks for any other', async () => {
  const t = owner({ answer: false, config: { registeredRepos: [B] } });
  t.picked.remember(A + path.sep);
  assert.deepEqual((await t.o.addRepo(A, 'win')).config.registeredRepos, [A, B]);
  assert.deepEqual(t.calls.confirm, []);

  assert.deepEqual(await t.o.addRepo(C, 'win'), { ok: false, error: 'not-confirmed' });
  assert.deepEqual(t.calls.confirm, [{ request: { kind: 'repo', path: C }, who: 'win' }]);
  assert.deepEqual(t.cfg().registeredRepos, [A, B]);

  // A registered repo moves to the front without asking.
  assert.deepEqual((await t.o.addRepo(B, 'win')).config.registeredRepos, [B, A]);
  assert.equal(t.calls.confirm.length, 1);

  const yes = owner({ answer: true });
  assert.deepEqual((await yes.o.addRepo(C, null)).config.registeredRepos, [C]);
  for (const bad of [42, '', '   ', null]) assert.deepEqual(await yes.o.addRepo(bad, null), { ok: false, error: 'invalid-request' });
});

test('repos:promote never asks: it reorders a registered repo, adds a picked one, ignores the rest', async () => {
  const t = owner({ config: { registeredRepos: [A, B] } });
  assert.deepEqual(t.o.promoteRepo(B).config.registeredRepos, [B, A]);
  assert.deepEqual(t.o.promoteRepo(C).config.registeredRepos, [B, A], 'a typed folder is not registered');
  t.picked.remember(C);
  assert.deepEqual(t.o.promoteRepo(C).config.registeredRepos, [C, B, A]);
  assert.deepEqual(t.calls.confirm, []);
});

test('repos:remove needs no dialog', () => {
  const t = owner({ config: { registeredRepos: [A, B] } });
  assert.deepEqual(t.o.removeRepo(A).config.registeredRepos, [B]);
  assert.deepEqual(t.calls.confirm, []);
});

test('changeHome: a picked folder or a recent home passes; any other path asks', async () => {
  const t = owner({ answer: false, config: { recentHives: [B] } });
  t.picked.remember(A);
  assert.equal(await t.o.homeAllowed(A, 'win'), true);
  assert.equal(await t.o.homeAllowed(B, 'win'), true);
  assert.deepEqual(t.calls.confirm, []);
  assert.equal(await t.o.homeAllowed(C, 'win'), false);
  assert.deepEqual(t.calls.confirm, [{ request: { kind: 'home', path: C }, who: 'win' }]);
});

test('onboarding: one call sets the wizard fields, only while onboarding is open', () => {
  const t = owner({ config: { onboardingComplete: false } });
  const res = t.o.completeOnboarding({
    harnessHome: ` ${A} `, registeredRepos: [B], autoMode: true, godProvider: 'claude', telemetryEnabled: false,
    // A main-owned field the wizard does not set is still dropped.
    approvedSpawns: [{ provider: 'claude', argv: ['calc'] }], defaultCommand: 'calc'
  });
  assert.equal(res.ok, true);
  assert.deepEqual(t.calls.ensure, [A]);
  assert.deepEqual(t.calls.write, [{ godProvider: 'claude', telemetryEnabled: false, harnessHome: A, registeredRepos: [B], autoMode: true, onboardingComplete: true }]);
  assert.deepEqual(t.calls.confirm, []);
  assert.deepEqual(t.o.completeOnboarding({ harnessHome: A, registeredRepos: [], autoMode: true }), { ok: false, error: 'already-onboarded' });
});

test('onboarding: a bad payload or a home that cannot be made writes nothing', () => {
  for (const bad of [null, [], { registeredRepos: [], autoMode: true }, { harnessHome: A, registeredRepos: 'x', autoMode: true }, { harnessHome: A, registeredRepos: [1], autoMode: true }, { harnessHome: A, registeredRepos: [], autoMode: 'on' }]) {
    const t = owner({ config: { onboardingComplete: false } });
    assert.equal(t.o.completeOnboarding(bad).error, 'invalid-request', JSON.stringify(bad));
    assert.deepEqual(t.calls.write, []);
  }
  const refused = owner({ config: { onboardingComplete: false }, ensure: { ok: false, error: 'network paths are refused' } });
  assert.deepEqual(refused.o.completeOnboarding({ harnessHome: A, registeredRepos: [], autoMode: false }), { ok: false, error: 'network paths are refused' });
  assert.deepEqual(refused.calls.write, []);
});

test('folder keys: one spelling per folder', () => {
  assert.equal(folderKey('D:\\Ws\\App\\', 'win32'), folderKey('d:\\ws\\app', 'win32'));
  assert.notEqual(folderKey('/ws/App', 'linux'), folderKey('/ws/app', 'linux'));
});

test('dialog text names the folder and cannot be forged with control characters', () => {
  const repo = confirmText({ kind: 'repo', path: 'D:/x\n\nOK' });
  assert.match(repo.detail, /Folder: D:\/x<U\+000A><U\+000A>OK/);
  assert.equal(confirmText({ kind: 'autoMode' }).yes, 'Turn on');
});

test('wiring: main-owned calls, the picked-folder record and the changeHome check', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /pickedFolders\.remember\(res\.filePaths\[0\]\);\s*return \{ ok: true as const, path: res\.filePaths\[0\] \};/);
  assert.match(src, /const newHome = resolve\(expandTilde\(p\.newHome\)\);\s*\/\/[^\n]*\n\s*if \(!\(await configOwner\.homeAllowed\(newHome, evt\.sender\)\)\) return \{ ok: false, error: NOT_CONFIRMED \};/);
  for (const [channel, call] of [
    ['config:setAutoMode', 'configOwner.setAutoMode(on, evt.sender)'],
    ['config:setOrchestratorMaySpawn', 'configOwner.setOrchestratorMaySpawn(on, evt.sender)'],
    ['config:completeOnboarding', 'configOwner.completeOnboarding(payload)'],
    ['repos:add', 'configOwner.addRepo(path, evt.sender)'],
    ['repos:promote', 'configOwner.promoteRepo(path)'],
    ['repos:remove', 'configOwner.removeRepo(path)']
  ]) {
    assert.ok(src.includes(`ipcMain.handle('${channel}', `) && src.includes(call), channel);
  }
  assert.match(src, /write: \(patch\) => applyConfigPatch\(patch\),/, 'main-owned writes keep config:update side effects');
});

test('settings: the two staged switches are saved through main-owned calls, not config:update', () => {
  const modal = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');
  const i = modal.indexOf('const saveAll');
  const body = modal.slice(i, modal.indexOf('\n  };', i));
  assert.match(body, /const \{ autoMode: stagedAutoMode, orchestratorMaySpawn: stagedOrchSpawn \} = pending;/);
  assert.match(body, /window\.cth\.setAutoMode\(stagedAutoMode\)/);
  assert.match(body, /window\.cth\.setOrchestratorMaySpawn\(stagedOrchSpawn\)/);
});

test('renderer: no updateConfig call or staged patch writes a main-owned field', () => {
  // Settings stages these two and saveAll routes them to main's own calls (test above).
  const stagedThroughMain = new Set(['autoMode', 'orchestratorMaySpawn']);
  const dir = path.join(__dirname, '..', 'src/renderer/src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
  walk(dir);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(updateConfig|stage)\(\{([^}]*)\}/g)) {
      for (const key of MAIN_OWNED_CONFIG_KEYS) {
        if (m[1] === 'stage' && stagedThroughMain.has(key)) continue;
        assert.doesNotMatch(m[2], new RegExp(`\\b${key}\\b\\s*[:,}]|\\b${key}\\s*$`), `${path.relative(dir, file)} writes ${key}`);
      }
    }
  }
});

test('repos: network and relative folders are refused before any dialog, and stored resolved', async () => {
  const t = owner({ answer: true, config: { onboardingComplete: false } });
  for (const bad of [String.raw`\\attacker\share`, '//attacker/share', String.raw`..\..\x`, 'relative/dir']) {
    assert.deepEqual(await t.o.addRepo(bad, null), { ok: false, error: 'invalid-request' }, bad);
    assert.deepEqual(t.o.promoteRepo(bad), { ok: false, error: 'invalid-request' }, bad);
    assert.equal(t.o.completeOnboarding({ harnessHome: A, registeredRepos: [B, bad], autoMode: false }).error, 'invalid-request', bad);
  }
  assert.deepEqual(t.calls.confirm, []);
  assert.deepEqual(t.calls.write, []);
  assert.deepEqual((await t.o.addRepo(path.join(A, 'sub', '..'), null)).config.registeredRepos, [A]);
});

test('voice: auto mode is not a voice setting, and voice config writes drop main-owned fields', () => {
  const actions = fs.readFileSync(path.join(__dirname, '..', 'src/main/realtimeActions.ts'), 'utf8');
  const policy = actions.slice(actions.indexOf('const SETTING_POLICY'), actions.indexOf('};', actions.indexOf('const SETTING_POLICY')));
  for (const key of MAIN_OWNED_CONFIG_KEYS) assert.doesNotMatch(policy, new RegExp(`^\\s*${key}:`, 'm'), key);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /patchConfig: \(patch\) => \{ applyConfigPatch\(withoutMainOwnedConfig\(patch as Partial<HarnessConfig>\)\); \}/);
});
