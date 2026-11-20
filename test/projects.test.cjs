'use strict';

// Workspace projects (ADR 0001): which folders count, how stored state merges,
// and that the service only ever touches paths it built itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const shared = loadTs('src/shared/project.ts');
const { ProjectService, readWorkspace, isLocalAbsolutePath } = loadTs('src/main/projects.ts');

function folder(name, over = {}) {
  return {
    name,
    path: `D:/ws/${name}`,
    isDirectory: true,
    isSymlink: false,
    isGitRepo: true,
    claudeMd: null,
    agentFiles: [],
    ...over
  };
}

// ─── pure rules ──────────────────────────────────────────────────────────────

test('only non-hidden, non-symlink git folders are projects', () => {
  assert.equal(shared.isProjectFolder(folder('mcx')), true);
  assert.equal(shared.isProjectFolder(folder('.claude')), false);
  assert.equal(shared.isProjectFolder(folder('Wrapper', { isGitRepo: false })), false);
  assert.equal(shared.isProjectFolder(folder('notes.zip', { isDirectory: false })), false);
  assert.equal(shared.isProjectFolder(folder('link', { isSymlink: true })), false);
});

test('project ids are stable slugs', () => {
  assert.equal(shared.projectIdFor('SmartTalk_Android-main'), 'smarttalk-android-main');
  assert.equal(shared.projectIdFor('___'), 'project');
  assert.equal(shared.isValidProjectId('__proto__'), false);
  assert.equal(shared.isValidProjectId('../etc'), false);
});

test('the ZetaHub key is read only from a back-ticked or upper-case value', () => {
  assert.equal(shared.parseZetahubKey('# MDM\nZetaHub project key: `MDM` (tickets shown as `MDM-51`)'), 'MDM');
  assert.equal(shared.parseZetahubKey('zetahub project key = `mcx-andr`'), 'MCX-ANDR');
  assert.equal(shared.parseZetahubKey('ZetaHub project key: DUSK.'), 'DUSK');
  assert.equal(shared.parseZetahubKey('ZetaHub project key: none yet'), null);
  assert.equal(shared.parseZetahubKey('ZetaHub project key: TBDlater'), null);
  assert.equal(shared.parseZetahubKey(null), null);
});

test('user key input is trimmed, upper-cased, capped, and empty clears it', () => {
  assert.deepEqual(shared.normalizeZetahubKey('  stand '), { ok: true, key: 'STAND' });
  assert.deepEqual(shared.normalizeZetahubKey(''), { ok: true, key: null });
  assert.deepEqual(shared.normalizeZetahubKey(null), { ok: true, key: null });
  assert.deepEqual(shared.normalizeZetahubKey('not a key'), { ok: false });
  assert.deepEqual(shared.normalizeZetahubKey('A'.repeat(65)), { ok: false });
  assert.deepEqual(shared.normalizeZetahubKey(42), { ok: false });
});

test('agent names come from .md files only, invalid names dropped', () => {
  assert.deepEqual(
    shared.agentNamesFrom(['go-dev.md', 'README.txt', 'mdm-protocol-expert.md', '../evil.md', 'a b.md']),
    ['go-dev', 'mdm-protocol-expert']
  );
});

test('new projects start disabled and serial; stored state wins', () => {
  const stored = shared.parseProjectsFile({
    version: 1,
    projects: { mcx: { enabled: true, parallel: true, zetahubKey: 'MCX-ANDR', leadAgentId: 'lead-mcx' } }
  });
  const list = shared.mergeProjects(
    [
      folder('mdm-platform', { claudeMd: 'ZetaHub project key: `MDM`', agentFiles: ['go-dev.md'] }),
      folder('mcx', { claudeMd: 'ZetaHub project key: `MCX`' }),
      folder('.idea'),
      folder('Wrapper', { isGitRepo: false })
    ],
    stored
  );
  assert.deepEqual(list.map((p) => p.id), ['mcx', 'mdm-platform']);
  const [mcx, mdm] = list;
  assert.equal(mcx.enabled, true);
  assert.equal(mcx.parallel, true);
  assert.equal(mcx.zetahubKey, 'MCX-ANDR', 'a user key overrides the CLAUDE.md key');
  assert.equal(mcx.zetahubKeySource, 'user');
  assert.equal(mcx.leadAgentId, 'lead-mcx');
  assert.equal(mdm.enabled, false);
  assert.equal(mdm.parallel, false);
  assert.equal(mdm.zetahubKey, 'MDM');
  assert.equal(mdm.zetahubKeySource, 'claude-md');
  assert.deepEqual(mdm.agents, ['go-dev']);
});

test('a folder named like an Object.prototype key gets default state', () => {
  const [project] = shared.mergeProjects([folder('constructor')], shared.emptyProjectsFile());
  assert.equal(project.id, 'constructor');
  assert.equal(project.enabled, false);
  assert.equal(project.leadAgentId, null);
});

test('folders with the same slug get distinct ids in code-point order', () => {
  const list = shared.mergeProjects([folder('my-app'), folder('My App')], shared.emptyProjectsFile());
  assert.deepEqual(list.map((p) => [p.name, p.id]), [['My App', 'my-app'], ['my-app', 'my-app-2']]);
});

test('a malformed projects.json degrades to empty entries', () => {
  assert.deepEqual({ ...shared.parseProjectsFile(null).projects }, {});
  const parsed = shared.parseProjectsFile({
    projects: { ok: { enabled: 'yes', zetahubKey: 'bad key' }, 'Bad Id': { enabled: true } }
  });
  assert.deepEqual({ ...parsed.projects }, { ok: { enabled: false, parallel: false } });
});

test('patching one project keeps the others and can clear the key', () => {
  let file = shared.patchStoredProject(shared.emptyProjectsFile(), 'a', { enabled: true, zetahubKey: 'DUSK' });
  file = shared.patchStoredProject(file, 'b', { parallel: true });
  file = shared.patchStoredProject(file, 'a', { zetahubKey: null });
  assert.deepEqual({ ...file.projects }, {
    a: { enabled: true, parallel: false },
    b: { enabled: false, parallel: true }
  });
});

test('only local absolute paths are accepted as a workspace', () => {
  assert.equal(isLocalAbsolutePath(path.resolve('ws')), true);
  assert.equal(isLocalAbsolutePath('relative/ws'), false);
  assert.equal(isLocalAbsolutePath('\\\\attacker\\share'), false);
  assert.equal(isLocalAbsolutePath('//attacker/share'), false);
});

test('a generic config patch never carries the workspace root', () => {
  assert.deepEqual(
    shared.withoutWorkspaceRoot({ workspaceRoot: '\\\\attacker\\share', autoMode: true }),
    { autoMode: true }
  );
  assert.deepEqual(shared.withoutWorkspaceRoot({}), {});
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /withoutWorkspaceRoot\(rawPatch/, 'config:update applies the strip');
});

// ─── disk and service ────────────────────────────────────────────────────────

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-projects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  const repo = (name) => fs.mkdirSync(path.join(ws, name, '.git'), { recursive: true });
  repo('mdm-platform');
  fs.writeFileSync(path.join(ws, 'mdm-platform', 'CLAUDE.md'), 'ZetaHub project key: `MDM`\n');
  fs.mkdirSync(path.join(ws, 'mdm-platform', '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'mdm-platform', '.claude', 'agents', 'go-dev.md'), '# go-dev\n');
  repo('mdm-core');
  fs.mkdirSync(path.join(ws, 'mdm-core', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'mdm-core', '.claude', 'CLAUDE.md'), '# Fleet\n');
  fs.mkdirSync(path.join(ws, 'Wrapper'));
  repo('.claude');
  fs.writeFileSync(path.join(ws, 'backlog.tsv'), 'x');
  const outside = path.join(dir, 'outside-repo');
  fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
  const hive = path.join(dir, 'home', 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const globals = path.join(dir, 'agents');
  fs.mkdirSync(globals);
  fs.writeFileSync(path.join(globals, 'reviewer.md'), '');
  return { dir, ws, hive, globals, outside };
}

function service(env, over = {}) {
  let root = over.root ?? null;
  const calls = { commits: [], pushes: [], logs: [] };
  const svc = new ProjectService({
    workspaceRoot: () => root,
    setWorkspaceRoot: (r) => { root = r; },
    hiveRoot: () => (over.noHive ? null : env.hive),
    commit: (m) => calls.commits.push(m),
    globalAgentsDir: env.globals,
    push: (s) => calls.pushes.push(s),
    log: (m) => calls.logs.push(m)
  });
  return { svc, calls };
}

test('readWorkspace finds only git folders and reads their CLAUDE.md and agents', async (t) => {
  const env = makeWorkspace(t);
  const res = await readWorkspace(env.ws);
  assert.equal(res.ok, true);
  const list = shared.mergeProjects(res.folders, shared.emptyProjectsFile());
  assert.deepEqual(list.map((p) => p.name), ['mdm-core', 'mdm-platform']);
  assert.equal(list[0].hasClaudeMd, true, '.claude/CLAUDE.md is found too');
  assert.equal(list[1].zetahubKey, 'MDM');
  assert.deepEqual(list[1].agents, ['go-dev']);
});

test('a junction to a repo outside the workspace is not a project', async (t) => {
  const env = makeWorkspace(t);
  try {
    fs.symlinkSync(env.outside, path.join(env.ws, 'linked-repo'), 'junction');
  } catch (e) {
    t.skip(`cannot create a junction here: ${e.code}`);
    return;
  }
  const res = await readWorkspace(env.ws);
  const names = shared.mergeProjects(res.folders, shared.emptyProjectsFile()).map((p) => p.name);
  assert.equal(names.includes('linked-repo'), false);
});

test('readWorkspace reports an unreadable root instead of throwing', async () => {
  const res = await readWorkspace(path.join(os.tmpdir(), `md-projects-missing-${Date.now()}`));
  assert.equal(res.ok, false);
  assert.match(res.error, /cannot read workspace/);
});

test('the service is empty until a workspace is picked, then persists toggles', async (t) => {
  const env = makeWorkspace(t);
  const { svc, calls } = service(env);

  const empty = await svc.rescan();
  assert.equal(empty.workspaceRoot, null);
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.globalAgents, ['reviewer']);

  assert.equal((await svc.setWorkspaceRoot('relative/path')).ok, false);
  assert.equal((await svc.setWorkspaceRoot('\\\\attacker\\share')).ok, false);
  const picked = await svc.setWorkspaceRoot(env.ws);
  assert.equal(picked.ok, true);
  assert.equal(picked.snapshot.projects.length, 2);

  const on = svc.patch('mdm-platform', { enabled: true });
  assert.equal(on.ok, true);
  assert.equal(on.snapshot.projects.find((p) => p.id === 'mdm-platform').enabled, true);
  assert.deepEqual(calls.commits, ['hive: project mdm-platform']);
  assert.deepEqual(calls.pushes.at(-1), on.snapshot, 'the window gets the same snapshot');
  const saved = JSON.parse(fs.readFileSync(path.join(env.hive, 'projects.json'), 'utf8'));
  assert.deepEqual(saved.projects['mdm-platform'], { enabled: true, parallel: false });
  assert.deepEqual(fs.readdirSync(env.hive).filter((f) => f.includes('.tmp-')), [], 'no temp file left');

  const cleared = await svc.setWorkspaceRoot(null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.snapshot.workspaceRoot, null);
  assert.deepEqual(cleared.snapshot.projects, []);
});

test('two toggles in a row are both saved', async (t) => {
  const env = makeWorkspace(t);
  const { svc } = service(env, { root: env.ws });
  await svc.rescan();
  const results = await Promise.all([
    Promise.resolve(svc.patch('mdm-core', { enabled: true })),
    Promise.resolve(svc.patch('mdm-platform', { parallel: true }))
  ]);
  assert.ok(results.every((r) => r.ok));
  const saved = JSON.parse(fs.readFileSync(path.join(env.hive, 'projects.json'), 'utf8'));
  assert.deepEqual(saved.projects, {
    'mdm-core': { enabled: true, parallel: false },
    'mdm-platform': { enabled: false, parallel: true }
  });
});

test('state of a folder that disappears is kept for when it comes back', async (t) => {
  const env = makeWorkspace(t);
  const { svc } = service(env, { root: env.ws });
  await svc.rescan();
  svc.patch('mdm-core', { enabled: true });
  fs.rmSync(path.join(env.ws, 'mdm-core'), { recursive: true, force: true });
  await svc.rescan();
  svc.patch('mdm-platform', { enabled: true });
  const saved = JSON.parse(fs.readFileSync(path.join(env.hive, 'projects.json'), 'utf8'));
  assert.deepEqual(saved.projects['mdm-core'], { enabled: true, parallel: false });
});

test('a corrupt projects.json is moved aside, not silently overwritten', async (t) => {
  const env = makeWorkspace(t);
  fs.writeFileSync(path.join(env.hive, 'projects.json'), '{ not json');
  const { svc, calls } = service(env, { root: env.ws });
  const snap = await svc.rescan();
  assert.equal(snap.projects.length, 2);
  assert.equal(snap.error, undefined);
  assert.equal(fs.readdirSync(env.hive).filter((f) => f.startsWith('projects.json.bad-')).length, 1);
  assert.match(calls.logs.join('\n'), /not valid JSON/);
});

test('a stored network or relative root is never read', async (t) => {
  const env = makeWorkspace(t);
  const { svc } = service(env, { root: '\\\\attacker\\share' });
  const snap = await svc.rescan();
  assert.deepEqual(snap.projects, []);
  assert.equal(snap.error, 'workspace is not a local folder');
});

test('an unreadable stored root is reported in the snapshot', async (t) => {
  const env = makeWorkspace(t);
  const { svc } = service(env, { root: path.join(env.dir, 'gone') });
  const snap = await svc.rescan();
  assert.match(snap.error, /cannot read workspace/);
});

test('scans publish in call order and list waits for the running scan', async (t) => {
  const env = makeWorkspace(t);
  const { svc, calls } = service(env);
  const picked = svc.setWorkspaceRoot(env.ws);
  const cleared = svc.setWorkspaceRoot(null);
  await Promise.all([picked, cleared]);
  assert.equal(calls.pushes.at(-1).workspaceRoot, null, 'the later call wins');

  const { svc: booting } = service(env, { root: env.ws });
  booting.rescan();
  const listed = await booting.current();
  assert.equal(listed.projects.length, 2, 'list does not return the empty boot state');
});

test('the scan queue: shared waiters, failure isolation, list after a failure', async (t) => {
  const env = makeWorkspace(t);
  let failNext = true;
  const calls = { pushes: [], logs: [] };
  const svc = new ProjectService({
    workspaceRoot: () => {
      if (failNext) { failNext = false; throw new Error('config unreadable'); }
      return env.ws;
    },
    setWorkspaceRoot: () => {},
    hiveRoot: () => env.hive,
    commit: () => {},
    globalAgentsDir: env.globals,
    push: (s) => calls.pushes.push(s),
    log: (m) => calls.logs.push(m)
  });
  const first = svc.rescan();
  assert.equal(svc.rescan(), first, 'calls made before a scan starts share it');
  await assert.rejects(first, /config unreadable/);
  assert.deepEqual((await svc.current()).projects, [], 'list answers after a failed scan');

  const running = svc.rescan();
  await Promise.resolve();
  await Promise.resolve();
  const queued = svc.rescan();
  assert.notEqual(queued, running, 'a call made during a scan queues one more');
  assert.equal(svc.rescan(), queued, 'and later callers share that queued scan');
  const [a, b] = await Promise.all([running, queued]);
  assert.equal(a.projects.length, 2);
  assert.equal(b.projects.length, 2);
  assert.equal(calls.pushes.length, 2, 'one push per scan, none for the failed one');
});

test('a window that cannot receive the push does not fail a saved toggle', async (t) => {
  const env = makeWorkspace(t);
  const logs = [];
  let throwOnPush = false;
  const svc = new ProjectService({
    workspaceRoot: () => env.ws,
    setWorkspaceRoot: () => {},
    hiveRoot: () => env.hive,
    commit: () => {},
    globalAgentsDir: env.globals,
    push: () => { if (throwOnPush) throw new Error('Object has been destroyed'); },
    log: (m) => logs.push(m)
  });
  await svc.rescan();
  throwOnPush = true;
  const res = svc.patch('mdm-core', { enabled: true });
  assert.equal(res.ok, true);
  assert.match(logs.join('\n'), /push failed/);
});

test('the service refuses unknown ids, bad keys and missing hives', async (t) => {
  const env = makeWorkspace(t);
  const { svc } = service(env, { root: env.ws });
  await svc.rescan();
  assert.deepEqual(svc.patch('../etc', { enabled: true }), { ok: false, error: 'invalid project id' });
  assert.deepEqual(svc.patch('wrapper', { enabled: true }), { ok: false, error: 'unknown project' });
  assert.deepEqual(svc.patch('mdm-core', { zetahubKey: 'not a key' }), { ok: false, error: 'invalid ZetaHub key' });

  const { svc: noHive } = service(env, { root: env.ws, noHive: true });
  await noHive.rescan();
  assert.deepEqual(noHive.patch('mdm-core', { enabled: true }), { ok: false, error: 'no hive yet' });
});

// ─── trust for room leads (ADR 0005) ────────────────────────────────────────

test('trust: off by default, on only for the stored folder path', () => {
  const stored = shared.parseProjectsFile({ version: 1, projects: { app: { enabled: true, parallel: false, trustedPath: 'D:\\ws\\App\\' } } });
  const [same] = shared.mergeProjects([folder('App', { path: 'd:/ws/app' })], stored);
  assert.equal(same.trusted, true);
  const [moved] = shared.mergeProjects([folder('App', { path: 'D:/ws2/App' })], stored);
  assert.equal(moved.trusted, false);
  const [fresh] = shared.mergeProjects([folder('App')], { version: 1, projects: {} });
  assert.equal(fresh.trusted, false);
});

test('trust: the file accepts only a non-empty path string', () => {
  for (const bad of [true, false, '', 42, null, 'x'.repeat(1025)]) {
    const file = shared.parseProjectsFile({ version: 1, projects: { app: { enabled: true, parallel: false, trustedPath: bad } } });
    assert.equal('trustedPath' in file.projects.app, false, String(bad));
  }
});

test('trust: patch sets and removes the path, ignores junk', () => {
  const base = { version: 1, projects: {} };
  const on = shared.patchStoredProject(base, 'app', { trustedPath: 'D:/ws/App' });
  assert.equal(on.projects.app.trustedPath, 'D:/ws/App');
  assert.equal('trustedPath' in shared.patchStoredProject(on, 'app', { trustedPath: null }).projects.app, false);
  assert.equal(shared.patchStoredProject(on, 'app', { trustedPath: '' }).projects.app.trustedPath, 'D:/ws/App');
  assert.equal(shared.patchStoredProject(on, 'app', {}).projects.app.trustedPath, 'D:/ws/App');
});

test('local open work path is read at scan time', () => {
  const [p] = shared.mergeProjects([folder('App', { claudeMd: 'Local open work: `docs/in-progress.md`' })], { version: 1, projects: {} });
  assert.equal(p.localWorkPath, 'docs/in-progress.md');
});
