'use strict';

// Main-side room wiring (ADR 0005, ADR 0007): Claude's folder trust read from a
// temp home, the project folder check, and which window gets a lead's card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { createRoomWiring } = loadTs('src/main/roomWiring.ts');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-wiring-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeWindow(over = {}) {
  const sent = [];
  const onDestroyed = [];
  return {
    sent,
    destroyed: false,
    once(event, fn) { if (event === 'destroyed') onDestroyed.push(fn); },
    destroy() { this.destroyed = true; onDestroyed.splice(0).forEach((fn) => fn()); },
    isDestroyed() { return this.destroyed; },
    send(channel, payload) {
      if (over.throws) throw new Error('window gone');
      sent.push([channel, payload]);
    }
  };
}

const ROOT = '1'.repeat(40);
const WIN_APP = ['D:', 'ws', 'App'].join('\\');

function wiring(over = {}) {
  const log = [];
  const patches = [];
  const w = createRoomWiring({
    homedir: () => over.home ?? os.tmpdir(),
    caseInsensitivePaths: process.platform === 'win32',
    workspaceRoot: () => over.root ?? null,
    liveWebContents: () => over.live ?? null,
    rootCommitsOutput: async () => ('rootOut' in over ? over.rootOut : `${ROOT}
`),
    patchProject: (id, patch) => { patches.push([id, patch]); return over.patchOk ?? true; },
    log: (line) => log.push(line)
  });
  return { w, log, patches };
}

function claudeJsonTrusting(home, folder) {
  const key = folder.replace(/\\/g, '/');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }));
}

test('Claude config: missing is null and quiet, unparsable is null and logged', async (t) => {
  const home = tempDir(t);
  const quiet = wiring({ home });
  assert.equal(await quiet.w.readClaudeConfig(), null);
  assert.deepEqual(quiet.log, []);
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  const loud = wiring({ home });
  assert.equal(await loud.w.readClaudeConfig(), null);
  assert.equal(loud.log.length, 1);
});

test('folder trust: a trusted parent covers a child folder', async (t) => {
  const home = tempDir(t);
  const ws = tempDir(t);
  const child = path.join(ws, 'app');
  claudeJsonTrusting(home, ws);
  assert.equal(await wiring({ home }).w.claudeTrustsFolder(child), true);
  assert.equal(await wiring({ home: tempDir(t) }).w.claudeTrustsFolder(child), false);
});

test('trust prompt: none only for an exactly trusted folder without .mcp.json', async (t) => {
  const home = tempDir(t);
  const ws = tempDir(t);
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  const { w } = wiring({ home });
  assert.equal(await w.leadMayMeetTrustPrompt(app), true, 'not trusted at all');
  claudeJsonTrusting(home, app);
  assert.equal(await w.leadMayMeetTrustPrompt(app), false);
  fs.writeFileSync(path.join(app, '.mcp.json'), '{}');
  assert.equal(await w.leadMayMeetTrustPrompt(app), true, 'project MCP servers still ask');
});

test('project folder: real path inside the workspace; nothing without a root, outside it, or through a link', async (t) => {
  const ws = tempDir(t);
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  assert.equal(await wiring({ root: null }).w.resolveProjectCwd(app), null);
  assert.equal(await wiring({ root: ws }).w.resolveProjectCwd(app), app);
  assert.equal(await wiring({ root: ws }).w.resolveProjectCwd(tempDir(t)), null);
  assert.equal(await wiring({ root: ws }).w.resolveProjectCwd(path.join(ws, 'missing')), null);
  const link = path.join(ws, 'linked');
  fs.symlinkSync(app, link, 'junction');
  assert.equal(await wiring({ root: ws }).w.resolveProjectCwd(link), null);
});

test('lead cards: archive goes to the owning window, else the live one; a dead window is logged', () => {
  const owner = fakeWindow();
  const live = fakeWindow();
  const { w, log } = wiring({ live });
  w.ownLead('lead--app', owner);
  w.archiveLeadCard('lead--app');
  assert.deepEqual(owner.sent, [['hive:agentArchived', { id: 'lead--app' }]]);
  w.archiveLeadCard('lead--app');
  assert.deepEqual(live.sent, [['hive:agentArchived', { id: 'lead--app' }]], 'the owner is forgotten after archive');
  const gone = fakeWindow();
  gone.destroyed = true;
  w.ownLead('lead--b', gone);
  assert.equal(w.leadWindow('lead--b'), live);
  const broken = wiring({ live: fakeWindow({ throws: true }) });
  broken.w.archiveLeadCard('lead--c');
  assert.equal(broken.log.length, 1);
  assert.deepEqual(log, []);
});

test('lead cards: announce sends the lead card and skips a destroyed window', () => {
  const target = fakeWindow();
  const { w } = wiring();
  w.announceLead('lead--app', 'App lead', 'D:/ws/App', target);
  assert.deepEqual(target.sent, [['hive:agentSpawned', { id: 'lead--app', name: 'App lead', provider: 'claude', cwd: 'D:/ws/App', command: 'claude', role: 'lead' }]]);
  target.destroyed = true;
  w.announceLead('lead--app', 'App lead', 'D:/ws/App', target);
  assert.equal(target.sent.length, 1);
});

test('trusted lead folder: only a trusted project, in its own plain folder', async (t) => {
  const ws = tempDir(t);
  const app = path.join(ws, 'App');
  const web = path.join(ws, 'Web');
  fs.mkdirSync(app);
  fs.mkdirSync(web);
  const projects = [
    { id: 'app', path: app, leadAgentId: 'lead--app', trusted: true, trustedRoot: ROOT },
    { id: 'web', path: web, leadAgentId: null, trusted: false }
  ];
  const { w } = wiring({ root: ws });
  assert.equal(await w.trustedLeadFolder('lead--app', app, projects), app);
  assert.equal(await w.trustedLeadFolder('lead--app', app.toUpperCase(), projects), process.platform === 'win32' ? app : null);
  assert.equal(await w.trustedLeadFolder('lead--web', web, projects), null, 'project not trusted');
  assert.equal(await w.trustedLeadFolder('lead--gone', app, projects), null, 'unknown lead fails closed');
  assert.equal(await w.trustedLeadFolder('lead--app', app, null), null, 'project list late: fail closed');
  assert.equal(await w.trustedLeadFolder('lead--app', web, projects), null, 'a replay with another cwd runs untrusted');
  const link = path.join(ws, 'link');
  fs.symlinkSync(app, link, 'junction');
  assert.equal(await w.trustedLeadFolder('lead--app', link, projects), null, 'a link to the project is not the project');
  const recloned = wiring({ root: ws, rootOut: `${'2'.repeat(40)}
` });
  assert.equal(await recloned.w.trustedLeadFolder('lead--app', app, projects), null, 'another repo in the folder runs untrusted');
});

test('still lead folder: a folder swapped for a link fails the last check', async (t) => {
  const ws = tempDir(t);
  const app = path.join(ws, 'App');
  const other = path.join(ws, 'Other');
  fs.mkdirSync(app);
  fs.mkdirSync(other);
  const { w } = wiring({ root: ws });
  assert.equal(await w.stillLeadFolder(app, app), true);
  fs.rmSync(app, { recursive: true });
  fs.symlinkSync(other, app, 'junction');
  assert.equal(await w.stillLeadFolder(app, app), false);
});

test('lead cards: a destroyed owner window is forgotten, a newer owner is kept', () => {
  const live = fakeWindow();
  const { w } = wiring({ live });
  const first = fakeWindow();
  w.ownLead('lead--app', first);
  first.destroy();
  first.destroyed = false; // even if it claimed to be alive, the entry is gone
  assert.equal(w.leadWindow('lead--app'), live);
  const old = fakeWindow();
  const next = fakeWindow();
  w.ownLead('lead--web', old);
  w.ownLead('lead--web', next);
  old.destroy();
  assert.equal(w.leadWindow('lead--web'), next);
});

test('trust state: none, trusted for the same repo, stale for another repo or no git', async () => {
  const project = { id: 'app', path: 'D:/ws/App', trusted: true, trustedRoot: ROOT };
  assert.equal(await wiring().w.trustState({ ...project, trusted: false }, 'D:/ws/App'), 'none');
  assert.equal(await wiring().w.trustState(project, 'D:/ws/App'), 'trusted');
  assert.equal(await wiring({ rootOut: `${'2'.repeat(40)}
` }).w.trustState(project, 'D:/ws/App'), 'stale');
  assert.equal(await wiring({ rootOut: null }).w.trustState(project, 'D:/ws/App'), 'unknown', 'git failed: nothing decided');
  assert.equal(await wiring({ rootOut: '' }).w.trustState(project, 'D:/ws/App'), 'stale', 'no commit any more: another repo');
  assert.equal(await wiring({ rootOut: '' }).w.repoRoot('D:/ws/App'), null, 'a repo with no commit has no root');
});

test('revoke: drops stored trust and Claude folder trust for both folder spellings, keeps the rest', async (t) => {
  const home = tempDir(t);
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({
    numStartups: 3,
    projects: {
      'D:/ws/App': { hasTrustDialogAccepted: true, allowedTools: ['x'] },
      [WIN_APP]: { hasTrustDialogAccepted: true },
      'D:/real/App': { hasTrustDialogAccepted: true },
      'D:/ws': { hasTrustDialogAccepted: true }
    }
  }));
  const { w, patches } = wiring({ home });
  assert.equal(await w.revokeTrust({ id: 'app', path: WIN_APP }, 'D:/real/App'), true);
  assert.deepEqual(patches, [['app', { trustedPath: null, trustedRoot: null }]]);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.numStartups, 3);
  assert.deepEqual(after.projects['D:/ws/App'], { allowedTools: ['x'] });
  assert.deepEqual(after.projects[WIN_APP], {});
  assert.deepEqual(after.projects['D:/real/App'], {});
  assert.deepEqual(after.projects['D:/ws'], { hasTrustDialogAccepted: true }, 'a parent the app never wrote is kept');
});

test('revoke: a missing Claude config is fine; an unreadable one or a failed save reports false', async (t) => {
  const project = { id: 'app', path: 'D:/ws/App' };
  assert.equal(await wiring({ home: tempDir(t) }).w.revokeTrust(project, null), true);
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  const broken = wiring({ home });
  assert.equal(await broken.w.revokeTrust(project, null), false);
  assert.equal(broken.patches.length, 1, 'stored trust is dropped even when Claude config is not');
  assert.equal(broken.log.length, 1);
  assert.equal(await wiring({ home: tempDir(t), patchOk: false }).w.revokeTrust(project, null), false);
});

test('root commits: read from a real repo, with repo-local fsmonitor and hooks turned off', async (t) => {
  const { rootCommitsOutput } = loadTs('src/main/git.ts');
  const { trustedRootFrom } = loadTs('src/shared/project.ts');
  const repo = tempDir(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  assert.equal(trustedRootFrom((await rootCommitsOutput(repo)) ?? ''), null, 'no commit yet');
  // A planted fsmonitor command would run on index reads; this call must not need it.
  git('config', 'core.fsmonitor', 'exit 1');
  git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'root');
  const head = git('rev-parse', 'HEAD').trim();
  assert.equal(trustedRootFrom((await rootCommitsOutput(repo)) ?? ''), head);
});

test('revoke: a key in another letter case is dropped on Windows, and no temp file is left', { skip: process.platform !== 'win32' }, async (t) => {
  const home = tempDir(t);
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ projects: { 'd:/WS/app/': { hasTrustDialogAccepted: true } } }));
  assert.equal(await wiring({ home }).w.revokeTrust({ id: 'app', path: 'D:/ws/App' }, null), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects['d:/WS/app/'], {});
  assert.deepEqual(fs.readdirSync(home), ['.claude.json']);
});
