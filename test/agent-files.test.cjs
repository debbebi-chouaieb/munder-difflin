'use strict';

// ADR 0015: agent files open in the editor or go to the trash, only for a
// definition the snapshot lists, at a path main builds itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createAgentFileHandlers } = loadTs('src/main/agentFiles.ts');

const def = (file) => ({ file, name: file, model: null, description: null, delegates: true });

function setup(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const agents = path.join(repo, '.claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'dev.md'), '# dev\n');
  fs.writeFileSync(path.join(agents, 'Go.MD'), '# go\n');
  fs.mkdirSync(path.join(agents, 'folder.md'));
  const globals = path.join(dir, 'globals');
  fs.mkdirSync(globals);
  fs.writeFileSync(path.join(globals, 'reviewer.md'), '# reviewer\n');
  const calls = { opened: [], trashed: [], rescans: 0, logs: [] };
  const snapshot = {
    workspaceRoot: dir,
    projects: [{ id: 'repo', path: repo, agents: [def('dev'), def('Go'), def('folder'), def('gone')] }],
    globalAgents: [def('reviewer')]
  };
  const handlers = createAgentFileHandlers({
    snapshot: async () => snapshot,
    globalAgentsDir: globals,
    openPath: async (p) => { calls.opened.push(p); return over.openError ?? ''; },
    trashItem: async (p) => {
      if (over.trashFails) throw new Error('locked');
      calls.trashed.push(p);
      fs.rmSync(p);
    },
    rescan: async () => { calls.rescans++; },
    log: (line) => calls.logs.push(line)
  });
  return { handlers, calls, agents, globals };
}

test('open: a listed project or global definition, at the path on disk', async (t) => {
  const { handlers, calls, agents, globals } = setup(t);
  assert.deepEqual(await handlers.open('project', 'repo', 'dev'), { ok: true });
  assert.deepEqual(await handlers.open('project', 'repo', 'Go'), { ok: true }, 'any case of the extension');
  assert.deepEqual(await handlers.open('global', null, 'reviewer'), { ok: true });
  assert.deepEqual(calls.opened, [path.join(agents, 'dev.md'), path.join(agents, 'Go.MD'), path.join(globals, 'reviewer.md')]);
});

test('open and trash refuse what the snapshot does not list or the disk does not hold', async (t) => {
  const { handlers, calls } = setup(t);
  const cases = [
    [['project', 'repo', '../escape'], 'invalid-request'],
    [['project', null, 'dev'], 'invalid-request'],
    [['global', 'repo', 'reviewer'], 'invalid-request'],
    [['team', 'repo', 'dev'], 'invalid-request'],
    [['project', 'repo', 'reviewer'], 'unknown-agent'],
    [['project', 'other', 'dev'], 'unknown-agent'],
    [['global', null, 'dev'], 'unknown-agent'],
    [['project', 'repo', 'gone'], 'not-a-file'],
    [['project', 'repo', 'folder'], 'not-a-file']
  ];
  for (const [args, error] of cases) {
    assert.deepEqual(await handlers.open(...args), { ok: false, error }, `open ${args.join(' ')}`);
    assert.deepEqual(await handlers.trash(...args), { ok: false, error }, `trash ${args.join(' ')}`);
  }
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.trashed, []);
  assert.equal(calls.rescans, 0);
});

test('trash moves the file and rescans; a failure is reported and logged', async (t) => {
  const ok = setup(t);
  assert.deepEqual(await ok.handlers.trash('project', 'repo', 'dev'), { ok: true });
  assert.equal(fs.existsSync(path.join(ok.agents, 'dev.md')), false);
  assert.equal(ok.calls.rescans, 1);

  const failing = setup(t, { trashFails: true });
  assert.deepEqual(await failing.handlers.trash('project', 'repo', 'dev'), { ok: false, error: 'trash-failed' });
  assert.equal(failing.calls.rescans, 0);
  assert.equal(failing.calls.logs.length, 1);
});

test('a linked .claude folder is refused even when the agents folder under it is real', async (t) => {
  const { handlers, calls, agents } = setup(t);
  const claude = path.dirname(agents);
  const moved = `${claude}-real`;
  fs.renameSync(claude, moved);
  fs.symlinkSync(moved, claude, 'junction');
  assert.deepEqual(await handlers.open('project', 'repo', 'dev'), { ok: false, error: 'not-a-file' });
  assert.deepEqual(await handlers.trash('project', 'repo', 'dev'), { ok: false, error: 'not-a-file' });
  assert.deepEqual(calls.opened, []);
  assert.equal(fs.existsSync(path.join(moved, 'agents', 'dev.md')), true, 'nothing was trashed through the link');
});

test('open reports the shell error', async (t) => {
  const { handlers, calls } = setup(t, { openError: 'no app' });
  assert.deepEqual(await handlers.open('project', 'repo', 'dev'), { ok: false, error: 'open-failed' });
  assert.match(calls.logs[0], /no app/);
});
