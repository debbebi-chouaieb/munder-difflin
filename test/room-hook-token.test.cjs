'use strict';

// ADR 0008: the cth-hook shim forwards this spawn's token. The agent id rule is
// unchanged: AGENT_ID only when Claude's payload has none.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function isolatedHive(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hook-token-'));
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
  return hive;
}

async function listen(t, sock) {
  const received = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => { /* the shim may hang up first */ });
    conn.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        received.push(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
        conn.end('{}\n');
      }
    });
  });
  server.on('error', () => { /* keep a socket error out of the test process */ });
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  return received;
}

function runShim(shim, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

test('cth-hook shim forwards the spawn token', async (t) => {
  const hive = isolatedHive(t);
  const sock = hive.sockPath();
  const received = await listen(t, sock);
  const shim = path.join(hive.root(), 'bin', 'cth-hook.cjs');
  const token = 'c'.repeat(64);

  const run = await runShim(
    shim,
    { HIVE_SOCK: sock, AGENT_ID: 'lead--app', HIVE_SPAWN_TOKEN: token },
    JSON.stringify({ hook_event_name: 'Stop' })
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(received.length, 1);
  assert.equal(received[0].agent_id, 'lead--app');
  assert.equal(received[0].spawn_token, token);
});

test('cth-hook shim sends no token when the spawn has none, and moves an agent_id Claude set to subagent_id (ADR 0011)', async (t) => {
  const hive = isolatedHive(t);
  const sock = hive.sockPath();
  const received = await listen(t, sock);
  const shim = path.join(hive.root(), 'bin', 'cth-hook.cjs');

  const withId = await runShim(shim, { HIVE_SOCK: sock, AGENT_ID: 'w1' }, JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(withId.code, 0, withId.stderr);
  const withoutId = await runShim(shim, { HIVE_SOCK: sock, AGENT_ID: 'w1' }, JSON.stringify({ hook_event_name: 'Stop', agent_id: 'x' }));
  assert.equal(withoutId.code, 0, withoutId.stderr);

  assert.equal(received.length, 2);
  assert.equal(received[0].agent_id, 'w1');
  assert.equal('spawn_token' in received[0], false);
  assert.equal('subagent_id' in received[0], false, "the lead's own hooks carry no subagent id");
  assert.equal(received[1].agent_id, 'w1', 'a hook fired inside a subagent belongs to the hive agent');
  assert.equal(received[1].subagent_id, 'x');
});

test("cth-hook shim keeps Claude's agent_id when the session was not spawned by the hive", async (t) => {
  const hive = isolatedHive(t);
  const sock = hive.sockPath();
  const received = await listen(t, sock);
  const shim = path.join(hive.root(), 'bin', 'cth-hook.cjs');

  const withId = await runShim(shim, { HIVE_SOCK: sock }, JSON.stringify({ hook_event_name: 'Stop', agent_id: 'x' }));
  assert.equal(withId.code, 0, withId.stderr);
  const withoutId = await runShim(shim, { HIVE_SOCK: sock }, JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(withoutId.code, 0, withoutId.stderr);

  assert.equal(received.length, 2);
  assert.equal(received[0].agent_id, 'x');
  assert.equal('subagent_id' in received[0], false);
  assert.equal(received[1].agent_id, null);
});

test('a tool call inside a subagent of a gated lead is denied (ADR 0011)', async (t) => {
  const { HookServer } = loadTs('src/main/hooks.ts');
  const hive = isolatedHive(t);
  const control = {
    shouldHalt: () => false,
    takeSteer: () => null,
    toolDecision: (agentId, tool) => ({ deny: agentId === 'lead--app' && tool === 'Bash', reason: 'gated' })
  };
  const server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const res = server.handle({
    hook_event_name: 'PreToolUse',
    agent_id: 'lead--app',
    subagent_id: 'a2ea79d51ca8c1558',
    agent_type: 'general-purpose',
    tool_name: 'Bash'
  });
  assert.equal(res.hookSpecificOutput.permissionDecision, 'deny');
});
