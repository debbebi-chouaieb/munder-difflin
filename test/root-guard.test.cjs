'use strict';

// fs:* and git:* IPC roots are limited to folders main knows (security audit of
// Phase 1): the workspace, live agent folders, the hive home, registered repos.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const guard = loadTs('src/main/rootGuard.ts');

test('network paths are never allowed', () => {
  assert.equal(guard.isNetworkPath('\\\\server\\share'), true);
  assert.equal(guard.isNetworkPath('//server/share'), true);
  assert.equal(guard.isNetworkPath('\\\\?\\UNC\\server\\share'), true);
  assert.equal(guard.isNetworkPath('D:\\zetabox'), false);
  assert.equal(guard.isWithinRoots('\\\\server\\share\\x', ['\\\\server\\share']), false);
});

test('a root must be a known folder or inside one', () => {
  const ws = path.resolve('ws-root');
  assert.equal(guard.isWithinRoots(ws, [ws]), true);
  assert.equal(guard.isWithinRoots(path.join(ws, 'mcx', 'platform'), [ws]), true);
  assert.equal(guard.isWithinRoots(ws + '-other', [ws]), false, 'a sibling with the same prefix is not inside');
  assert.equal(guard.isWithinRoots(path.join(ws, '..', 'elsewhere'), [ws]), false, 'traversal is resolved first');
  assert.equal(guard.isWithinRoots(path.dirname(ws), [ws]), false, 'a parent is not inside');
  assert.equal(guard.isWithinRoots('relative/path', [ws]), false);
  assert.equal(guard.isWithinRoots(ws, []), false);
  assert.equal(guard.isWithinRoots(ws, ['', 'relative']), false, 'empty and relative roots allow nothing');
});

test('drive letters compare without case on Windows', () => {
  assert.equal(guard.isWithinRoots('d:\\ZetaBox\\mcx', ['D:\\zetabox'], true), true);
  assert.equal(guard.isWithinRoots('/Users/me/WS', ['/users/me/ws'], false), false, 'case-sensitive elsewhere');
});

test('the guard returns the real path, refuses links out, and missing folders', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rootguard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(ws, 'repo'), { recursive: true });
  fs.mkdirSync(outside);
  const real = await guard.resolveAllowedRoot(path.join(ws, 'repo'), [ws]);
  assert.equal(real, fs.realpathSync.native(path.join(ws, 'repo')), 'the operation gets the checked real path');
  assert.equal(await guard.resolveAllowedRoot(outside, [ws]), null);
  assert.equal(await guard.resolveAllowedRoot(path.join(ws, 'missing'), [ws]), null);
  assert.equal(await guard.resolveAllowedRoot('\\\\server\\share', [ws]), null);
  assert.equal(await guard.resolveAllowedRoot(42, [ws]), null);
  try {
    fs.symlinkSync(outside, path.join(ws, 'escape'), 'junction');
  } catch (e) {
    t.skip(`cannot create a junction here: ${e.code}`);
    return;
  }
  assert.equal(await guard.resolveAllowedRoot(path.join(ws, 'escape'), [ws]), null);
});

test('the short (8.3) and long name of one folder match', async (t) => {
  // os.tmpdir() is often an 8.3 path on Windows (C:\Users\ABCDEF~1\...).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rootguard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const longForm = fs.realpathSync.native(dir);
  assert.equal(await guard.resolveAllowedRoot(dir, [longForm]), longForm);
  assert.equal(await guard.resolveAllowedRoot(longForm, [dir]), longForm);
});

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const handlerBody = (name) => {
  const start = indexSrc.indexOf(`ipcMain.handle('${name}'`);
  return indexSrc.slice(start, indexSrc.indexOf('\n});', start));
};

test('every fs, git and github handler that takes a root checks it', () => {
  const handlers = [...indexSrc.matchAll(/ipcMain\.handle\('((?:fs|git|github):\w+)'/g)].map((m) => m[1]);
  const rootless = new Set(['fs:statAbs', 'fs:revealPath']); // absolute paths from agent output, network refused
  for (const name of handlers) {
    const body = handlerBody(name);
    if (rootless.has(name)) {
      assert.match(body, /isNetworkPath\(p\)/, `${name} refuses network paths`);
    } else {
      assert.match(body, /await allowedRoot\((root|cwd)\)/, `${name} checks its root`);
      assert.doesNotMatch(body.split('allowedRoot(')[1], /\((root|cwd)[,)]/, `${name} uses the checked path afterwards`);
    }
  }
  assert.ok(handlers.length >= 21, `found ${handlers.length} handlers`);
});

test('other path inputs refuse network folders', () => {
  assert.match(handlerBody('kg:ingestFiles'), /isLocalAbsolute\(srcPath\)/);
  assert.match(handlerBody('skills:local'), /\.filter\(isLocalAbsolute\)/);
  assert.match(handlerBody('config:ensureHome'), /isNetworkPath\(path\)/);
  assert.match(handlerBody('config:changeHome'), /isNetworkPath\(p\.newHome\)/);
  const spawn = indexSrc.slice(indexSrc.indexOf('async function spawnAgentCore'), indexSrc.indexOf('async function spawnAgentCore') + 2500);
  assert.match(spawn, /isNetworkPath\(opts\.cwd\)/);
});

test('a checkout sees a busy agent whatever the path spelling', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rootguard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const realRepo = fs.realpathSync.native(repo);
  const now = 1_000_000;
  const busy = (cwd, ago = 1000) => ({ id: cwd, cwd, lastOutputAt: now - ago });
  const forward = repo.split(path.sep).join('/');
  assert.ok(await guard.busyTerminalIn([busy(forward)], realRepo, now), 'forward slashes match the native separator');
  assert.ok(await guard.busyTerminalIn([busy(path.join(repo, 'sub'))], realRepo, now), 'a terminal in a subfolder is busy');
  if (process.platform === 'win32') {
    assert.ok(await guard.busyTerminalIn([busy(repo.toUpperCase())], realRepo, now), 'case does not matter on Windows');
  }
  assert.equal(await guard.busyTerminalIn([busy(repo, 20_000)], realRepo, now), undefined, 'idle for 20 s is not busy');
  assert.equal(await guard.busyTerminalIn([busy(dir)], realRepo, now), undefined, 'a parent folder is not inside');
});

test('isolated agents keep their original repo reachable for the IDE git panes', () => {
  const start = indexSrc.indexOf('const knownRoots');
  const body = indexSrc.slice(start, indexSrc.indexOf('};', start));
  assert.match(body, /worktreeOrigins\.values\(\)/);
  assert.match(body, /hive\.registry\(\)\.agents/);
  assert.match(handlerBody('git:checkout'), /await busyTerminalIn\(ptyManager\.list\(\), allowed\)/);
});
