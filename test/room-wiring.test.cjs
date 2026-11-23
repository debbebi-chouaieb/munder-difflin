'use strict';

// Main-side room wiring (ADR 0005, ADR 0007): Claude's folder trust read from a
// temp home, the project folder check, and which window gets a lead's card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createRoomWiring } = loadTs('src/main/roomWiring.ts');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-wiring-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeWindow(over = {}) {
  const sent = [];
  return {
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(channel, payload) {
      if (over.throws) throw new Error('window gone');
      sent.push([channel, payload]);
    }
  };
}

function wiring(over = {}) {
  const log = [];
  const w = createRoomWiring({
    homedir: () => over.home ?? os.tmpdir(),
    caseInsensitivePaths: process.platform === 'win32',
    workspaceRoot: () => over.root ?? null,
    liveWebContents: () => over.live ?? null,
    log: (line) => log.push(line)
  });
  return { w, log };
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
