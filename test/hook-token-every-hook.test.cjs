'use strict';

// ADR 0010: every spawn's hook events carry its token. Main drops an event for an
// agent it issued a token to unless the event carries that token, and every
// sender forwards HIVE_SPAWN_TOKEN.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');

const { SpawnTokens } = loadTs('src/main/spawnTokens.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// ── SpawnTokens ──────────────────────────────────────────────────────────────

test('an agent without an issued token is unissued, whatever the event carries', () => {
  const tokens = new SpawnTokens(() => TOKEN);
  assert.equal(tokens.check('w1', undefined), 'unissued');
  assert.equal(tokens.check('w1', TOKEN), 'unissued');
});

test('an issued token must match exactly', () => {
  const tokens = new SpawnTokens(() => TOKEN);
  tokens.issue('w1', tokens.next());
  assert.equal(tokens.check('w1', TOKEN), 'ok');
  assert.equal(tokens.check('w1', OTHER), 'rejected');
  assert.equal(tokens.check('w1', undefined), 'rejected');
  assert.equal(tokens.check('w1', 42), 'rejected');
  assert.equal(tokens.check('w1', TOKEN.slice(1)), 'rejected');
  assert.equal(tokens.check('w2', undefined), 'unissued', 'tokens are per agent');
});

test('a new spawn replaces the token, so the old spawn is refused', () => {
  const minted = [TOKEN, OTHER];
  const tokens = new SpawnTokens(() => minted.shift());
  tokens.issue('w1', tokens.next());
  tokens.issue('w1', tokens.next());
  assert.equal(tokens.check('w1', TOKEN), 'rejected');
  assert.equal(tokens.check('w1', OTHER), 'ok');
});

test('the default mint makes distinct 64-char hex tokens', () => {
  const tokens = new SpawnTokens();
  const a = tokens.next();
  const b = tokens.next();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

// ── HookServer ───────────────────────────────────────────────────────────────

function hookServer(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hook-token-server-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const logs = [];
  const sessions = [];
  hive.appendLog = (e) => { logs.push(e); };
  hive.recordSession = (agentId, sessionId) => { sessions.push([agentId, sessionId]); };
  const tokens = new SpawnTokens(() => TOKEN);
  tokens.issue('w1', tokens.next());
  const seen = [];
  const server = new HookServer(
    hive, () => null, () => ({ notifications: false }), undefined, undefined, undefined,
    (agentId, event, _message, spawnToken) => { seen.push([agentId, event, spawnToken]); },
    (agentId, spawnToken) => tokens.check(agentId, spawnToken)
  );
  return { server, logs, sessions, seen };
}

test('a forged event for an issued agent touches no state and is logged without the token', (t) => {
  const { server, logs, sessions, seen } = hookServer(t);
  for (const spawn_token of [undefined, OTHER]) {
    const res = server.handle({ agent_id: 'w1', hook_event_name: 'Stop', session_id: 'evil', spawn_token });
    assert.deepEqual(res, {});
  }
  assert.deepEqual(seen, [], 'onEvent must not see a dropped event');
  assert.deepEqual(sessions, [], 'a dropped event must not record a session');
  const rejected = logs.filter((e) => e.kind === 'hook-token-rejected');
  assert.deepEqual(rejected, [
    { kind: 'hook-token-rejected', agentId: 'w1', event: 'Stop' },
    { kind: 'hook-token-rejected', agentId: 'w1', event: 'Stop' }
  ]);
  assert.ok(!JSON.stringify(logs).includes(OTHER), 'the log must never hold a token');
});

test('a dropped PreToolUse is denied, so a sender that lost the token fails closed', (t) => {
  const { server, seen } = hookServer(t);
  const res = server.handle({ agent_id: 'w1', hook_event_name: 'PreToolUse', tool_name: 'Bash', spawn_token: OTHER });
  assert.equal(res.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /token/);
  assert.deepEqual(seen, []);
});

test('an event with the right token, or for an unissued agent, is handled', (t) => {
  const { server, logs, sessions, seen } = hookServer(t);
  server.handle({ agent_id: 'w1', hook_event_name: 'Stop', session_id: 's1', spawn_token: TOKEN });
  server.handle({ agent_id: 'sub-1', hook_event_name: 'Stop', session_id: 's2' });
  assert.deepEqual(seen, [['w1', 'Stop', TOKEN], ['sub-1', 'Stop', undefined]]);
  assert.deepEqual(sessions, [['w1', 's1'], ['sub-1', 's2']]);
  assert.equal(logs.filter((e) => e.kind === 'hook-token-rejected').length, 0);
});

test('an event without an agent id is not token-checked', (t) => {
  const { server, logs, seen } = hookServer(t);
  server.handle({ hook_event_name: 'Stop' });
  assert.deepEqual(seen, [[undefined, 'Stop', undefined]]);
  assert.equal(logs.filter((e) => e.kind === 'hook-token-rejected').length, 0);
});

test('the AGENT_ID a spawn gets is the hive id main issues its token under', async (t) => {
  const { hive } = isolatedHive(t);
  hive.startProxyBridge = async () => 43210;
  for (const provider of ['claude', 'codex', 'gemini', 'crush']) {
    const id = `${provider}-1`;
    const inj = await hive.ensureAgent({ id, name: id, provider, cwd: hive.root() }, { spawnToken: TOKEN });
    assert.equal(inj.env.AGENT_ID, id, provider);
  }
});

// ── every sender forwards the token ──────────────────────────────────────────

function isolatedHive(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hook-token-senders-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = path.join(base, 'user');
  process.env.USERPROFILE = process.env.HOME;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), process.env.HOME, 'home redirect failed');
  const hive = new HiveManager(() => path.join(base, 'harness'));
  hive.ensureHive();
  return { hive, base };
}

async function listen(t, sock) {
  const received = [];
  let notify = () => {};
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => { /* the sender may hang up first */ });
    conn.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        received.push(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
        conn.end('{}\n');
        notify();
      }
    });
  });
  server.on('error', () => { /* keep a socket error out of the test process */ });
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  const waitFor = (count) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`expected ${count} payloads, got ${received.length}`)), 10_000);
    const check = () => { if (received.length >= count) { clearTimeout(timer); resolve(received); } };
    notify = check;
    check();
  });
  return { received, waitFor };
}

function run(args, env, stdin = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

const SHIMS = [
  { name: 'agy', install: (hive) => hive.installAgyHooks(), file: 'agy-hook.cjs', args: ['Stop'], stdin: '{}' },
  { name: 'gemini', install: (hive, dir) => hive.installGeminiHooks(dir), file: 'gemini-hook.cjs', args: [], stdin: JSON.stringify({ hook_event_name: 'AfterAgent' }) },
  { name: 'grok', install: (hive) => hive.installGrokHooks(), file: 'grok-hook.cjs', args: [], stdin: JSON.stringify({ hookEventName: 'stop' }) }
];

for (const shim of SHIMS) {
  test(`${shim.name} hook shim forwards the spawn token`, async (t) => {
    const { hive, base } = isolatedHive(t);
    const dir = path.join(hive.root(), 'agents', 'w1');
    fs.mkdirSync(dir, { recursive: true });
    shim.install(hive, dir);
    const file = findFile(base, shim.file);
    assert.ok(file, `${shim.file} was not written`);
    const sock = hive.sockPath();
    const { waitFor } = await listen(t, sock);

    const res = await run([file, ...shim.args], { HIVE_SOCK: sock, AGENT_ID: 'w1', HIVE_SPAWN_TOKEN: TOKEN }, shim.stdin);
    assert.equal(res.code, 0, res.stderr);
    const [payload] = await waitFor(1);
    assert.equal(payload.agent_id, 'w1');
    assert.equal(payload.spawn_token, TOKEN);
  });
}

test('Pi extension forwards the spawn token', async (t) => {
  const { hive } = isolatedHive(t);
  const dir = path.join(hive.root(), 'agents', 'w1');
  fs.mkdirSync(dir, { recursive: true });
  hive.installPiHooks(dir);
  const ext = findFile(dir, 'hive-bridge.js');
  const sock = hive.sockPath();
  const { waitFor } = await listen(t, sock);

  const driver = `require(${JSON.stringify(ext)})({ on: (ev, fn) => { if (ev === 'agent_end') fn(); } });`;
  const res = await run(['-e', driver], { HIVE_SOCK: sock, AGENT_ID: 'w1', HIVE_SPAWN_TOKEN: TOKEN });
  assert.equal(res.code, 0, res.stderr);
  const [payload] = await waitFor(1);
  assert.equal(payload.hook_event_name, 'Stop');
  assert.equal(payload.spawn_token, TOKEN);
});

test('OpenCode plugin forwards the spawn token', async (t) => {
  const { hive, base } = isolatedHive(t);
  const dir = path.join(hive.root(), 'agents', 'w1');
  fs.mkdirSync(dir, { recursive: true });
  hive.installOpenCodePlugin(dir);
  // The plugin is ESM in a .js file; give the copy an .mjs name so Node loads it as ESM.
  const plugin = path.join(base, 'hive-bridge.mjs');
  fs.copyFileSync(findFile(dir, 'hive-bridge.js'), plugin);
  const sock = hive.sockPath();
  const { waitFor } = await listen(t, sock);

  const driver = `import(${JSON.stringify(pathToFileURL(plugin).href)}).then(async (m) => { const h = await m.HiveBridge(); await h.event({ event: { type: 'session.idle' } }); });`;
  const res = await run(['-e', driver], { HIVE_SOCK: sock, AGENT_ID: 'w1', HIVE_SPAWN_TOKEN: TOKEN });
  assert.equal(res.code, 0, res.stderr);
  const [payload] = await waitFor(1);
  assert.equal(payload.hook_event_name, 'Stop');
  assert.equal(payload.spawn_token, TOKEN);
});

test('ensureAgent hands the spawn token to the proxy bridge sidecar', async (t) => {
  const { hive } = isolatedHive(t);
  const configs = [];
  hive.startProxyBridge = async (_agentId, cfg) => { configs.push(cfg); return 43210; };
  await hive.ensureAgent({ id: 'crush-1', name: 'Crush Worker', provider: 'crush', cwd: hive.root() }, { spawnToken: TOKEN });
  assert.equal(configs.length, 1);
  assert.equal(configs[0].spawnToken, TOKEN);
});

test('proxy bridge sidecar forwards the spawn token on the hooks it synthesizes', async (t) => {
  const { hive } = isolatedHive(t);
  const sock = hive.sockPath();
  const { waitFor } = await listen(t, sock);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { content: 'hi' } }] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());

  const child = spawn(process.execPath, [path.join(hive.root(), 'bin', 'hive-proxy.cjs')], {
    env: {
      PATH: process.env.PATH,
      HIVE_SOCK: sock,
      AGENT_ID: 'w1',
      HIVE_SPAWN_TOKEN: TOKEN,
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      HIVE_PROXY_SESSION: 's1',
      HIVE_PROXY_API: 'openai'
    },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(JSON.parse(buf).port); });
  });
  assert.ok(port > 0, 'the sidecar did not bind');

  await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: 'POST', body: '{}' }).then((r) => r.text());
  const payloads = await waitFor(1);
  assert.ok(payloads.every((p) => p.spawn_token === TOKEN), JSON.stringify(payloads.map((p) => p.hook_event_name)));
});
