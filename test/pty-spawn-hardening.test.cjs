'use strict';

// pty:spawn audit (2026-11-28): the renderer's spawn request keeps known fields
// only, and git calls never run a repo's own fsmonitor command.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { spawnRequestFromRenderer } = loadTs('src/main/ptySpawnRequest.ts');

const BASE = { id: 'worker-1', cwd: 'D:/ws/App', command: 'claude' };

test('spawn request: main-only options from the renderer are dropped', () => {
  const req = spawnRequestFromRenderer({
    ...BASE,
    env: { NODE_OPTIONS: '--require evil.js', ANTHROPIC_BASE_URL: 'https://attacker.invalid' },
    shellScript: 'calc.exe',
    untrusted: false,
    noAutoInstall: true,
    somethingNew: 1
  });
  assert.deepEqual(req, BASE);
});

test('spawn request: known fields are kept, hive meta copied field by field', () => {
  const raw = {
    ...BASE,
    provider: 'claude',
    args: ['--model', 'opus'],
    cols: 120,
    rows: 32,
    isolate: true,
    resume: true,
    requireResume: false,
    resumeSessionId: 'abc',
    hive: { id: 'worker-1', name: 'Pam', cwd: 'D:/ws/App', provider: 'claude', role: 'worker', capabilities: ['code'], isGod: true, extra: 'x' }
  };
  const req = spawnRequestFromRenderer(raw);
  assert.deepEqual(req, { ...raw, hive: { id: 'worker-1', name: 'Pam', cwd: 'D:/ws/App', provider: 'claude', role: 'worker', capabilities: ['code'], isGod: true } });
  assert.notEqual(req.args, raw.args, 'arrays are copied');
});

test('spawn request: a missing or mistyped field refuses the whole request', () => {
  for (const bad of [
    null, 'x', [], {},
    { ...BASE, id: 1 }, { ...BASE, cwd: undefined }, { ...BASE, command: ['claude'] },
    { ...BASE, args: 'a b' }, { ...BASE, args: ['ok', 2] },
    { ...BASE, cols: 0 }, { ...BASE, rows: 1.5 }, { ...BASE, cols: 5000 },
    { ...BASE, provider: 7 }, { ...BASE, resumeSessionId: {} },
    // Main puts the id after a resume flag once the recipe check has run.
    { ...BASE, resumeSessionId: '--allow-all-tools' }, { ...BASE, resumeSessionId: 'abc & calc' },
    { ...BASE, resumeSessionId: 'abc\ncalc' }, { ...BASE, resumeSessionId: 'a'.repeat(129) },
    { ...BASE, isolate: 'yes' }, { ...BASE, resume: 1 }, { ...BASE, requireResume: null },
    { ...BASE, hive: 'god' }, { ...BASE, hive: { id: 'x', name: 'y' } }, { ...BASE, hive: { id: 'x', name: 'y', cwd: 'z', capabilities: [1] } }
  ]) {
    assert.equal(spawnRequestFromRenderer(bad), null, JSON.stringify(bad));
  }
});

test('spawn request: real session ids and an empty id are kept', () => {
  for (const id of ['', 'abc', '0f8fad5b-d9cb-469f-a165-70867728950e', 'conv_123', ' abc ']) {
    assert.equal(spawnRequestFromRenderer({ ...BASE, resumeSessionId: id }).resumeSessionId, id, JSON.stringify(id));
  }
});

test('wiring: pty:spawn builds its options from the request parser', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /ipcMain\.handle\('pty:spawn', async \(evt, raw: unknown\) => \{[^]*?const opts: AgentSpawnOptions \| null = spawnRequestFromRenderer\(raw\);\s*if \(!opts\) return \{ ok: false, error: 'invalid SpawnOptions' \};/);
});

test('git: a repo-local fsmonitor command never runs for status, branch or worktree diff calls', async (t) => {
  const git = loadTs('src/main/git.ts');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
  run('init', '-q');
  run('commit', '-q', '--allow-empty', '--no-verify', '-m', 'root');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');
  // The planted command leaves a marker if git ever runs it.
  const marker = path.join(repo, 'fsmonitor-ran');
  const script = path.join(repo, process.platform === 'win32' ? 'mon.cmd' : 'mon.sh');
  fs.writeFileSync(script, process.platform === 'win32' ? `@echo off\r\necho x> "${marker}"\r\n` : `#!/bin/sh\necho x > "${marker}"\n`, { mode: 0o755 });
  run('config', 'core.fsmonitor', script.replace(/\\/g, '/'));
  const status = await git.getStatus(repo);
  assert.equal('error' in status, false, JSON.stringify(status));
  await git.getBranch(repo);
  await git.worktreeHasUnintegratedWork(repo, 'HEAD');
  assert.equal(fs.existsSync(marker), false, 'the repo fsmonitor command ran');
});

test('git: the worktree diff check turns off external diff and textconv drivers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/git.ts'), 'utf8');
  assert.match(src, /\['diff', '--quiet', '--no-ext-diff', '--no-textconv', baseBranch, 'HEAD'\]/);
  assert.match(src, /spawn\('git', \[\.\.\.NO_REPO_FSMONITOR, \.\.\.args\], \{ cwd \}\)/);
});
