'use strict';

// Which agent rows light up while a session runs them as subagents (ADR 0014):
// the reducer, the shadowing rule, the hook contract, main's emit and Claude's
// hook registration.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { withSubagentEvent, activeAgentRows } = loadTs('src/shared/subagentActivity.ts');
const { validateHookEvent } = loadTs('src/shared/hookEvents.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const def = (file, name = file, model = null) => ({ file, name, model, description: null });
const start = (agentId, subagentId, subagentType) => ({ agentId, event: 'SubagentStart', subagentId, subagentType });
const stop = (agentId, subagentId) => ({ agentId, event: 'SubagentStop', subagentId });
const apply = (events) => events.reduce(withSubagentEvent, {});

// ─── reducer ─────────────────────────────────────────────────────────────────

test('SubagentStart adds a run and SubagentStop removes it', () => {
  const running = apply([start('god', 's1', 'reviewer'), start('god', 's2', 'test-runner')]);
  assert.deepEqual(running, { god: { s1: 'reviewer', s2: 'test-runner' } });
  assert.deepEqual(withSubagentEvent(running, stop('god', 's1')), { god: { s2: 'test-runner' } });
  assert.deepEqual(apply([start('god', 's1', 'reviewer'), stop('god', 's1')]), {}, 'the last stop drops the agent');
});

test('a lead Stop keeps background runs; SessionStart drops them', () => {
  const running = apply([start('god', 's1', 'reviewer'), { agentId: 'god', event: 'Stop' }]);
  assert.deepEqual(running, { god: { s1: 'reviewer' } });
  assert.deepEqual(withSubagentEvent(running, { agentId: 'god', event: 'SessionStart' }), {});
});

test('events without a valid id or type, or for another agent, change nothing', () => {
  const running = apply([start('god', 's1', 'reviewer')]);
  for (const e of [
    start('god', 's2', undefined),
    start('god', 's2', 'plugin:reviewer'),
    start('god', '../x', 'reviewer'),
    start(undefined, 's2', 'reviewer'),
    stop('god', 'unknown'),
    stop('jim', 's1'),
    { agentId: 'god', event: 'PreToolUse', subagentId: 's1', subagentType: 'reviewer' }
  ]) {
    assert.equal(withSubagentEvent(running, e), running, JSON.stringify(e));
  }
});

// ─── shadowing rule ──────────────────────────────────────────────────────────

const projects = [
  { id: 'pos', leadAgentId: null, agents: [def('reviewer'), def('arch', 'architect')] },
  { id: 'chajara', leadAgentId: null, agents: [def('reviewer')] }
];
const globals = [def('reviewer'), def('test-runner'), def('sec', 'security-auditor')];

test('a project lead running an agent its project defines lights only that desk', () => {
  const rows = activeAgentRows(apply([start('lead--pos', 's1', 'reviewer')]), new Set(['lead--pos']), projects, globals);
  assert.deepEqual([...rows.desks.pos], ['reviewer']);
  assert.equal(rows.desks.chajara, undefined);
  assert.equal(rows.globals.size, 0, 'the project agent shadows the global one');
});

test('runs match the frontmatter name and light the row by file', () => {
  const running = apply([start('lead--pos', 's1', 'architect'), start('god', 's2', 'security-auditor')]);
  const rows = activeAgentRows(running, new Set(['lead--pos', 'god']), projects, globals);
  assert.deepEqual([...rows.desks.pos], ['arch']);
  assert.deepEqual([...rows.globals], ['sec']);
});

test('a type the project lacks, or a run outside any project, lights the global row', () => {
  const running = apply([start('lead--pos', 's1', 'test-runner'), start('god', 's2', 'reviewer')]);
  const rows = activeAgentRows(running, new Set(['lead--pos', 'god']), projects, globals);
  assert.deepEqual([...rows.globals].sort(), ['reviewer', 'test-runner']);
  assert.deepEqual(rows.desks, {});
});

test('built-in types light nothing, and agents without a live terminal are ignored', () => {
  const running = apply([start('god', 's1', 'Explore'), start('lead--pos', 's2', 'reviewer')]);
  const rows = activeAgentRows(running, new Set(['god']), projects, globals);
  assert.equal(rows.globals.size, 0);
  assert.deepEqual(rows.desks, {});
});

// ─── hook contract and main ──────────────────────────────────────────────────

test('the hook event contract accepts valid subagent fields and rejects others', () => {
  assert.equal(validateHookEvent({ event: 'SubagentStart', subagentId: 'a2ea79d51ca8c1558', subagentType: 'Explore' }), true);
  assert.equal(validateHookEvent({ event: 'SubagentStart', subagentId: 'a b' }), false);
  assert.equal(validateHookEvent({ event: 'SubagentStart', subagentType: 'plugin:x' }), false);
  assert.equal(validateHookEvent({ event: 'SubagentStart', subagentId: 7 }), false);
});

async function server(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-subagents-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home });
  const sent = [];
  const srv = new HookServer(hive, () => ({ send: (channel, payload) => sent.push({ channel, payload }) }), () => ({}), undefined, undefined);
  const events = () => sent.filter((s) => s.channel === 'hive:hookEvent').map((s) => s.payload);
  return { home, srv, events };
}

test('main forwards the subagent id and type to the renderer', async (t) => {
  const { srv, events } = await server(t);
  await srv.handle({ agent_id: 'god', hook_event_name: 'SubagentStart', subagent_id: 'a2ea79d51ca8c1558', agent_type: 'reviewer' });
  const [e] = events();
  assert.equal(e.event, 'SubagentStart');
  assert.equal(e.subagentId, 'a2ea79d51ca8c1558');
  assert.equal(e.subagentType, 'reviewer');
});

test('main drops a type that does not fit instead of losing the event', async (t) => {
  const { srv, events } = await server(t);
  await srv.handle({ agent_id: 'god', hook_event_name: 'SubagentStart', subagent_id: 's1', agent_type: 'my-plugin:reviewer' });
  const [e] = events();
  assert.equal(e.subagentId, 's1');
  assert.equal('subagentType' in e, false);
});

test('Claude spawns register SubagentStart and SubagentStop', async (t) => {
  const { home } = await server(t);
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'hive/agents/god/settings.json'), 'utf8'));
  assert.ok(settings.hooks.SubagentStart?.length, 'SubagentStart is registered');
  assert.ok(settings.hooks.SubagentStop?.length, 'SubagentStop is registered');
});
