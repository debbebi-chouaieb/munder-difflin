'use strict';

// ADR 0020 ticket 1: main checks every renderer spawn against the recipe the
// renderer builds commands with; anything else needs a person at a native dialog.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { buildSpawnCommand, isOnRecipe, permissionSkipArgs, isApprovedSpawn } = loadTs('src/shared/spawnRecipe.ts');
const { tokenizeCommand } = loadTs('src/shared/commandLine.ts');
const { AGENT_PROVIDER_PRESETS, providerPreset } = loadTs('src/shared/agentProvider.ts');
const { createSpawnRecipeGate, spawnConfirmText, spawnConfirmDialog } = loadTs('src/main/spawnRecipeGate.ts');

const CONFIG = { defaultCommand: 'claude', autoMode: false };
const argvOf = (config, model, provider) => tokenizeCommand(buildSpawnCommand(config, model, provider));

test('recipe: every command buildSpawnCommand gives is on recipe, with and without model and auto mode', () => {
  for (const preset of AGENT_PROVIDER_PRESETS) {
    if (preset.id === 'custom') continue;
    for (const autoMode of [false, true]) {
      const config = { ...CONFIG, autoMode };
      for (const model of [undefined, 'some-model', 'Gemini 3.1 Pro (High)']) {
        const argv = argvOf(config, model, preset.id);
        assert.equal(isOnRecipe(config, preset.id, argv), true, `${preset.id} ${autoMode} ${model}: ${argv.join(' ')}`);
      }
    }
  }
});

test('recipe: the user configured claude command is the base, and custom uses it too', () => {
  const config = { defaultCommand: 'claude-beta --verbose', autoMode: false };
  assert.equal(isOnRecipe(config, 'claude', ['claude-beta', '--verbose', '--model', 'opus']), true);
  assert.equal(isOnRecipe(config, 'claude', ['claude', '--model', 'opus']), false);
  assert.equal(isOnRecipe(config, 'custom', ['claude-beta', '--verbose']), true);
  assert.equal(isOnRecipe({ defaultCommand: '', autoMode: false }, 'custom', ['anything']), false, 'custom with no command has no recipe');
});

test('recipe: the auto flag is on recipe only while auto mode is on', () => {
  const auto = tokenizeCommand(providerPreset('claude').autoFlag);
  assert.equal(isOnRecipe(CONFIG, 'claude', ['claude', ...auto]), false);
  assert.equal(isOnRecipe({ ...CONFIG, autoMode: true }, 'claude', ['claude', ...auto]), true);
  assert.equal(isOnRecipe({ ...CONFIG, autoMode: true }, 'claude', ['claude']), true, 'auto mode does not force the flag');
});

test('recipe: other binaries, extra args, reordered flags and flag-shaped model values are off recipe', () => {
  for (const argv of [
    ['calc.exe'],
    ['claude', '--dangerously-skip-permissions'],
    ['claude', '--model', 'opus', '--settings', 'evil.json'],
    ['claude', '--model'],
    ['claude', '--model', ''],
    ['claude', '--model', '--dangerously-skip-permissions'],
    ['claude', '--permission-mode', 'bypassPermissions', '--model', 'opus'],
    ['codex', '--model', 'gpt']
  ]) {
    assert.equal(isOnRecipe({ ...CONFIG, autoMode: true }, 'claude', argv), false, argv.join(' '));
  }
});

test('recipe: a model value with shell or control characters is off recipe; real model ids are on it', () => {
  for (const model of ['claude-opus-4-8[1m]', 'openai/gpt-5', 'pi:high', 'Gemini 3.1 Pro (High)', 'gpt-5.6-sol', 'a+b@c']) {
    assert.equal(isOnRecipe(CONFIG, 'claude', ['claude', '--model', model]), true, model);
  }
  for (const model of ['opus\ncalc', 'x" & calc & "', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', 'a!b', 'a&b', "a'b", 'a\tb', ' leading', 'a\u202eb']) {
    assert.equal(isOnRecipe(CONFIG, 'claude', ['claude', '--model', model]), false, JSON.stringify(model));
  }
});

test('permission-skip args: preset auto flags and flags named like them are found', () => {
  assert.deepEqual(permissionSkipArgs(['--model', 'opus']), []);
  assert.deepEqual(permissionSkipArgs(['--permission-mode', 'bypassPermissions']), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(permissionSkipArgs(['-a', 'never', '-s', 'workspace-write']), ['-a', 'never', '-s', 'workspace-write']);
  assert.deepEqual(permissionSkipArgs(['--x', '--dangerously-skip-permissions']), ['--dangerously-skip-permissions']);
  assert.deepEqual(permissionSkipArgs(['--yolo']), ['--yolo']);
  assert.deepEqual(permissionSkipArgs(['-a']), [], 'a lone token of a longer flag is not the flag');
});

test('approved spawn shape: provider plus a non-empty string argv', () => {
  assert.equal(isApprovedSpawn({ provider: 'claude', argv: ['claude'] }), true);
  for (const bad of [null, 'x', {}, { provider: 'claude', argv: [] }, { provider: 1, argv: ['a'] }, { provider: 'claude', argv: ['a', 2] }]) {
    assert.equal(isApprovedSpawn(bad), false, JSON.stringify(bad));
  }
});

function gate({ config = CONFIG, approved = [], answer = false } = {}) {
  const calls = { confirm: [], approve: [] };
  let resolveAsk = null;
  const confirmSpawn = createSpawnRecipeGate({
    config: () => config,
    approved: () => approved,
    approve: (spawn) => { calls.approve.push(spawn); approved = [...approved, spawn]; },
    confirm: (request, owner) => {
      calls.confirm.push({ request, owner });
      return answer === 'wait' ? new Promise((r) => { resolveAsk = r; }) : Promise.resolve(answer);
    }
  });
  return { confirmSpawn, calls, release: (yes) => resolveAsk(yes) };
}

const OFF = { provider: 'claude', argv: ['claude', '--dangerously-skip-permissions'], cwd: 'D:/ws/App' };

test('gate: an on-recipe spawn starts without a dialog', async () => {
  const { confirmSpawn, calls } = gate();
  assert.equal(await confirmSpawn({ provider: 'claude', argv: ['claude', '--model', 'opus'], cwd: 'D:/ws/App' }, 'win'), true);
  assert.deepEqual(calls.confirm, []);
});

test('gate: an off-recipe spawn asks in the spawning window; Cancel refuses and remembers nothing', async () => {
  const { confirmSpawn, calls } = gate({ answer: false });
  assert.equal(await confirmSpawn(OFF, 'win'), false);
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].owner, 'win');
  assert.deepEqual(calls.confirm[0].request, { ...OFF, skipArgs: ['--dangerously-skip-permissions'] });
  assert.deepEqual(calls.approve, []);
});

test('gate: Start runs it and remembers it, so the same command does not ask again', async () => {
  const { confirmSpawn, calls } = gate({ answer: true });
  assert.equal(await confirmSpawn(OFF, null), true);
  assert.deepEqual(calls.approve, [{ provider: 'claude', argv: OFF.argv }]);
  assert.equal(await confirmSpawn({ ...OFF, cwd: 'D:/ws/Other' }, null), true);
  assert.equal(calls.confirm.length, 1);
  // Another provider with the same argv is a different approval.
  await confirmSpawn({ ...OFF, provider: 'custom' }, null);
  assert.equal(calls.confirm.length, 2);
});

test('gate: identical spawns asked at once share one dialog', async () => {
  const { confirmSpawn, calls, release } = gate({ answer: 'wait' });
  const a = confirmSpawn(OFF, null);
  const b = confirmSpawn(OFF, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.confirm.length, 1);
  release(true);
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(calls.approve.length, 1);
});

test('dialog: names the command and folder, warns on permission-skip args, and defaults to Cancel', async () => {
  const text = spawnConfirmText({ ...OFF, argv: ['my cli', '--dangerously-skip-permissions'], skipArgs: ['--dangerously-skip-permissions'] });
  assert.match(text.detail, /Command: "my cli" --dangerously-skip-permissions/);
  assert.match(text.detail, /Folder: D:\/ws\/App/);
  assert.match(text.detail, /Warning: --dangerously-skip-permissions/);
  assert.doesNotMatch(spawnConfirmText({ ...OFF, skipArgs: [] }).detail, /Warning/);
  // A crafted folder or arg cannot forge dialog lines or hide text with bidi or zero-width characters.
  const forged = spawnConfirmText({ ...OFF, argv: ['claude', 'a\u202eb', 'c\u200bd'], cwd: 'D:/x\n\nCommand: claude', skipArgs: [] }).detail;
  assert.match(forged, /Folder: D:\/x<U\+000A><U\+000A>Command: claude/);
  assert.match(forged, /a<U\+202E>b c<U\+200B>d/);
  assert.equal(forged.split('\n').filter((l) => l.startsWith('Command:')).length, 1);

  const shown = [];
  const confirm = spawnConfirmDialog(async (owner, options) => { shown.push({ owner, options }); return { response: shown.length === 1 ? 0 : 1 }; });
  assert.equal(await confirm({ ...OFF, skipArgs: [] }, 'win'), true);
  assert.equal(await confirm({ ...OFF, skipArgs: [] }, 'win'), false);
  assert.equal(shown[0].owner, 'win');
  assert.deepEqual(shown[0].options.buttons, ['Start', 'Cancel']);
  assert.equal(shown[0].options.defaultId, 1);
  assert.equal(shown[0].options.cancelId, 1);
});

test('config: approved spawns are added once, removed without a dialog, and malformed entries are ignored', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-approved-spawns-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const electron = require.resolve('electron');
  const saved = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
  t.after(() => { if (saved) require.cache[electron] = saved; else delete require.cache[electron]; });
  const config = loadTs('src/main/config.ts');
  config.writeConfig({});
  config.readConfig();

  const spawn = { provider: 'claude', argv: ['claude', '--x'] };
  config.addApprovedSpawn(spawn);
  config.addApprovedSpawn({ ...spawn, argv: [...spawn.argv] });
  assert.deepEqual(config.approvedSpawns(), [spawn]);

  config.writeConfig({ approvedSpawns: [spawn, { provider: 'claude', argv: [] }, 'junk'] });
  assert.deepEqual(config.approvedSpawns(), [spawn], 'a malformed entry is never trusted');

  config.removeApprovedSpawn(spawn);
  assert.deepEqual(config.approvedSpawns(), []);
  assert.throws(() => config.removeApprovedSpawn({ provider: 'claude' }), /invalid approved spawn/);
});

test('wiring: pty:spawn checks the recipe before spawnAgentCore, config:update never writes approvedSpawns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /spawnUnlessLead\(\{ id: opts\.id, hiveId: opts\.hive\?\.id \}, async \(\) =>\s*\(await rendererSpawnConfirmed\(opts, owner\)\) \? spawnAgentCore\(opts, owner\) : \{ ok: false, error: SPAWN_NOT_CONFIRMED \}\);/);
  assert.match(src, /function rendererSpawnConfirmed\([^)]*\): Promise<boolean> \{\s*const provider = inferAgentProvider\(opts\.command, opts\.provider \?\? opts\.hive\?\.provider\);\s*return spawnRecipeGate\(\{ provider, argv: \[opts\.command, \.\.\.\(opts\.args \?\? \[\]\)\], cwd: expandTilde\(opts\.cwd\) \}, owner\);/);
  assert.match(src, /const \{ approvedSpawns: _confirmedInMain, \.\.\.patch \} = withoutWorkspaceRoot\(rawPatch \?\? \{\}\);/);
  assert.match(src, /ipcMain\.handle\('config:removeApprovedSpawn', \(_evt, spawn: unknown\) => removeApprovedSpawn\(spawn\)\);/);
});

test('wiring: the voice spawn action goes through the same check before spawnAgentCore', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /spawnAgent: async \(opts\) => \{\s*const o = opts as AgentSpawnOptions;\s*\/\/[^\n]*\n\s*const res = await spawnUnlessLead\(\{ id: o\.id, hiveId: o\.hive\?\.id \}, async \(\) =>\s*\(await rendererSpawnConfirmed\(o, liveWebContents\(\)\)\) \? spawnAgentCore\(o, null\) : \{ ok: false, error: SPAWN_NOT_CONFIRMED \}\);/);
});

test('renderer: buildSpawnCommand is the shared recipe, not a copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/store/config.ts'), 'utf8');
  assert.match(src, /export \{ buildSpawnCommand \} from '@shared\/spawnRecipe';/);
  assert.doesNotMatch(src, /function buildSpawnCommand/);
});
