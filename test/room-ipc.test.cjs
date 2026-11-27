'use strict';

// Project room IPC (ADR 0005, ADR 0003 amended): calls take a project id only,
// the lead's spawn options are built in main, untrusted projects ask first, a
// large session asks first, and errors are fixed codes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { buildLeadSpawn, leadAgentIdFor, parseOpenRequest, spawnPosture, leadIdOfSpawn, isLeadAgentId, withoutClaudeBypassArgs } = loadTs('src/shared/roomLead.ts');
const { claudeTrustCovers, claudeTrustsExactly, trustPromptExpected, projectMcpConfigNear, mcpConfigCandidates, TrustPromptGate, hookProvesTurn } = loadTs('src/shared/claudeTrust.ts');
const { createRoomHandlers } = loadTs('src/main/roomIpc.ts');
const { createLeadLock, spawnUnderLeadLock, LEAD_BUSY_ERROR } = loadTs('src/main/leadLock.ts');

const ABC = '00000000-0000-4000-8000-000000000abc';
const BIG = '00000000-0000-4000-8000-000000000b19';
const NULLSIZE = '00000000-0000-4000-8000-0000000000aa';
const ROOT = '1111111111111111111111111111111111111111';
const PROJECT = {
  id: 'app', name: 'App', path: 'D:/ws/App', leadAgentId: null, enabled: true, trusted: true,
  zetahubKey: null, localWorkPath: null
};

function deps(over = {}) {
  const calls = { spawn: [], patch: [], kill: [], archive: [], announce: [], log: [], revoke: [], forget: [], touch: [] };
  const running = new Set(over.running ?? []);
  const sessions = {
    [ABC]: { id: ABC, large: false, contextTokens: 10 },
    [BIG]: { id: BIG, large: true, contextTokens: 150_000 },
    [NULLSIZE]: { id: NULLSIZE, large: true, contextTokens: null }
  };
  const d = {
    projects: async () => [{ ...PROJECT, ...(over.project ?? {}) }],
    resolveProjectCwd: async (p) => (over.moved ? null : `${p}-real`),
    claudeTrusts: async () => over.claudeTrusts ?? false,
    sessions: { list: async () => Object.values(sessions), summaryOf: async (_p, id) => sessions[id] ?? null },
    tickets: async () => ({ zetahub: { ok: false, key: null, reason: 'no-key' }, local: { ok: false, reason: 'no-line' } }),
    isRunning: (id) => running.has(id),
    spawnLead: async (opts) => { calls.spawn.push(opts); running.add(opts.id); return over.spawnResult ?? { ok: true }; },
    announceLead: (...args) => calls.announce.push(args),
    patchProject: (id, patch) => { calls.patch.push([id, patch]); return over.patchOk ?? true; },
    trustState: async (p) => over.trustState ?? (p.trusted ? 'trusted' : 'none'),
    revokeTrust: async (p, cwd) => { calls.revoke.push([p.id, cwd]); return true; },
    forgetTrust: async (p, cwd) => { calls.forget.push([p.id, cwd]); return over.forgetOk ?? true; },
    repoRoot: async () => ('repoRoot' in over ? over.repoRoot : ROOT),
    killLead: (id) => { calls.kill.push(id); if (over.killFails) return { ok: false, error: 'EPERM' }; running.delete(id); return { ok: true }; },
    archiveLead: (id) => { calls.archive.push(id); },
    liveLeadIds: () => [...running].filter((id) => id.startsWith('lead--')),
    roomPtyCap: () => over.cap ?? 3,
    touchLead: (id) => { calls.touch.push(id); },
    leadLastUsed: (id) => over.lastUsed?.[id] ?? 0,
    leadLock: over.leadLock ?? createLeadLock(),
    log: (m) => calls.log.push(m)
  };
  return { d, calls };
}

// ─── pure rules ──────────────────────────────────────────────────────────────

test('lead id: derived from the project, a foreign stored id is ignored', () => {
  assert.equal(leadAgentIdFor({ id: 'app', leadAgentId: null }), 'lead--app');
  assert.equal(leadAgentIdFor({ id: 'app', leadAgentId: 'lead--app-2' }), 'lead--app-2');
  assert.equal(leadAgentIdFor({ id: 'app', leadAgentId: 'god' }), 'lead--app');
  assert.equal(leadAgentIdFor({ id: 'app', leadAgentId: 'lead-app' }), 'lead--app');
});

test('spawn options: claude in the checked folder, resume only for a chosen session', () => {
  const fresh = buildLeadSpawn(PROJECT, 'D:/real', null, true);
  assert.equal(fresh.command, 'claude');
  assert.equal(fresh.cwd, 'D:/real');
  assert.equal(fresh.resume, false);
  assert.equal(fresh.untrusted, false);
  assert.equal('resumeSessionId' in fresh, false);
  assert.deepEqual(fresh.hive, { id: 'lead--app', name: 'App lead', role: 'lead', cwd: 'D:/real', provider: 'claude' });

  const resumed = buildLeadSpawn(PROJECT, 'D:/real', ABC, false);
  assert.equal(resumed.resume, true);
  assert.equal(resumed.requireResume, true);
  assert.equal(resumed.resumeSessionId, ABC);
  assert.equal(resumed.untrusted, true);
  assert.throws(() => buildLeadSpawn(PROJECT, 'D:/real', '--dangerously-skip-permissions', true));
});

test('spawn posture: untrusted grants neither pre-accept nor auto mode', () => {
  assert.deepEqual(spawnPosture(false, true), { preAcceptTrust: true, autoMode: true });
  assert.deepEqual(spawnPosture(false, false), { preAcceptTrust: true, autoMode: false });
  assert.deepEqual(spawnPosture(true, true), { preAcceptTrust: false, autoMode: false });
});

test('lead id of a spawn: both ids must agree when either is a lead id', () => {
  assert.deepEqual(leadIdOfSpawn('lead--app', 'lead--app'), { ok: true, leadId: 'lead--app' });
  assert.deepEqual(leadIdOfSpawn('lead--app', undefined), { ok: true, leadId: 'lead--app' });
  assert.deepEqual(leadIdOfSpawn('dev-1', 'dev-1'), { ok: true, leadId: null }); // other agents unchanged
  assert.deepEqual(leadIdOfSpawn('lead-dev-1732000000000', undefined), { ok: true, leadId: null }); // a hand-hired "Lead Dev"
  assert.equal(leadIdOfSpawn('lead--app', 'x').ok, false); // a plain hive id must not hide a lead
  assert.equal(leadIdOfSpawn('x', 'lead--app').ok, false);
  assert.equal(leadIdOfSpawn('lead--app', 'lead--web').ok, false);
  assert.equal(isLeadAgentId('lead--app'), true);
  assert.equal(isLeadAgentId('lead-dev-1'), false);
});

test('bypass args are stripped for an untrusted lead, other args kept', () => {
  assert.deepEqual(
    withoutClaudeBypassArgs(['--model', 'x', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--permission-mode=acceptEdits', '--allow-dangerously-skip-permissions', '--resume', 'id']),
    ['--model', 'x', '--resume', 'id']
  );
  assert.deepEqual(withoutClaudeBypassArgs([]), []);
});

test('only real turns release the trust gate', () => {
  for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) assert.equal(hookProvesTurn(e), true, e);
  for (const e of ['Status', 'SessionStart', 'Notification', undefined]) assert.equal(hookProvesTurn(e), false, String(e));
});

test('claude trust: the folder or a parent, either slash, case-insensitive on Windows', () => {
  const cfg = { projects: { 'D:/ws': { hasTrustDialogAccepted: true }, 'D:/other/App': { hasTrustDialogAccepted: false } } };
  assert.equal(claudeTrustCovers(cfg, 'D:\\ws\\App', true), true);
  assert.equal(claudeTrustCovers(cfg, 'd:\\WS', true), true);
  assert.equal(claudeTrustCovers(cfg, 'D:\\wsx\\App', true), false);
  assert.equal(claudeTrustCovers(cfg, 'D:\\other\\App', true), false);
  assert.equal(claudeTrustCovers(cfg, 'd:/ws', false), false);
  assert.equal(claudeTrustCovers(null, 'D:/ws', true), false);
  assert.equal(claudeTrustCovers({ projects: { '': { hasTrustDialogAccepted: true } } }, 'D:/ws', true), false);
});

test('claude trust, exact: only the folder itself counts, not a trusted parent', () => {
  const cfg = { projects: { 'D:/ws': { hasTrustDialogAccepted: true }, 'D:/ws/App': { hasTrustDialogAccepted: true } } };
  assert.equal(claudeTrustsExactly(cfg, 'D:\\ws\\App\\', true), true);
  assert.equal(claudeTrustsExactly(cfg, 'D:\\ws\\Web', true), false, 'trusted only through D:/ws');
  assert.equal(claudeTrustsExactly(null, 'D:/ws', true), false);
});

test('trust prompt gate: armed unless Claude trusts the exact folder and it has no project MCP servers', () => {
  // Parent trust skips the folder dialog but still shows the .mcp.json approval prompt.
  assert.equal(trustPromptExpected({ claudeTrustsExactly: false, hasProjectMcp: false }), true);
  assert.equal(trustPromptExpected({ claudeTrustsExactly: true, hasProjectMcp: true }), true);
  assert.equal(trustPromptExpected({ claudeTrustsExactly: false, hasProjectMcp: true }), true);
  assert.equal(trustPromptExpected({ claudeTrustsExactly: true, hasProjectMcp: false }), false);
});

test('mcp probe: the folder and every parent, nearest first, either separator', () => {
  assert.deepEqual(mcpConfigCandidates('D:\\ws\\App'), ['D:\\ws\\App\\.mcp.json', 'D:\\ws\\.mcp.json', 'D:\\.mcp.json']);
  assert.deepEqual(mcpConfigCandidates('/home/u/App/'), ['/home/u/App/.mcp.json', '/home/u/.mcp.json', '/home/.mcp.json', '/.mcp.json']);
});

test('mcp probe: only "not found" everywhere means none; a parent file, a link or an error counts (fail closed)', async () => {
  const enoent = () => Object.assign(new Error('nope'), { code: 'ENOENT' });
  const probe = (answers) => {
    const asked = [];
    const logs = [];
    const lstat = async (p) => { asked.push(p); const a = answers[p]; if (a) throw a(); return {}; };
    return { asked, logs, run: () => projectMcpConfigNear('D:\\ws\\App', lstat, (l) => logs.push(l)) };
  };
  const none = { 'D:\\ws\\App\\.mcp.json': enoent, 'D:\\ws\\.mcp.json': enoent, 'D:\\.mcp.json': enoent };
  const a = probe(none);
  assert.equal(await a.run(), false);
  assert.equal(a.asked.length, 3);

  const parent = probe({ 'D:\\ws\\App\\.mcp.json': enoent });
  assert.equal(await parent.run(), true, 'a workspace-level .mcp.json counts');
  assert.deepEqual(parent.asked, ['D:\\ws\\App\\.mcp.json', 'D:\\ws\\.mcp.json'], 'stops at the first hit');

  for (const code of ['EACCES', 'ENOTDIR', 'EPERM']) {
    const err = probe({ ...none, 'D:\\ws\\App\\.mcp.json': () => Object.assign(new Error(code), { code }) });
    assert.equal(await err.run(), true, code);
    assert.equal(err.logs.length, 1);
  }
});

test('trust prompt gate: held until released', () => {
  const gate = new TrustPromptGate();
  assert.equal(gate.blocks('lead--app'), false);
  gate.hold('lead--app', 'tok-1');
  assert.equal(gate.blocks('lead--app'), true);
  gate.release('lead--app', 'tok-1');
  assert.equal(gate.blocks('lead--app'), false);
});

test('trust prompt gate: a closing terminal releases only its own spawn', () => {
  const gate = new TrustPromptGate();
  gate.hold('lead--app', 'new');
  gate.release('lead--app', 'old'); // the previous spawn's terminal closes late
  assert.equal(gate.blocks('lead--app'), true);
  gate.release('lead--app', 'new');
  assert.equal(gate.blocks('lead--app'), false);
});

test('trust prompt gate: a turn releases only with the current spawn token (ADR 0008)', () => {
  const gate = new TrustPromptGate();
  gate.hold('lead--app', 'a'.repeat(64));
  // Forged or tokenless payloads, and a token of the wrong length, keep it held.
  for (const bad of [undefined, null, 42, '', 'b'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal(gate.releaseOnTurn('lead--app', bad), false, String(bad));
    assert.equal(gate.blocks('lead--app'), true, String(bad));
  }
  // Another agent's id with the right token releases nothing.
  assert.equal(gate.releaseOnTurn('lead--other', 'a'.repeat(64)), false);
  assert.equal(gate.blocks('lead--app'), true);
  assert.equal(gate.releaseOnTurn('lead--app', 'a'.repeat(64)), true);
  assert.equal(gate.blocks('lead--app'), false);
  assert.equal(gate.releaseOnTurn('lead--app', 'a'.repeat(64)), false, 'not held any more');
});

test('trust prompt gate: a late turn from the previous spawn does not release its replacement', () => {
  const gate = new TrustPromptGate();
  gate.hold('lead--app', 'old');
  gate.release('lead--app', 'old'); // the old terminal closed
  gate.hold('lead--app', 'new');
  assert.equal(gate.releaseOnTurn('lead--app', 'old'), false);
  assert.equal(gate.blocks('lead--app'), true);
  assert.equal(gate.releaseOnTurn('lead--app', 'new'), true);
});

test('open request parsing', () => {
  assert.deepEqual(parseOpenRequest(null), { sessionId: null, confirmLarge: false, trust: null, trustPath: null });
  assert.deepEqual(parseOpenRequest({ sessionId: ABC, trust: 'no' }), { sessionId: ABC, confirmLarge: false, trust: 'no', trustPath: null });
  assert.deepEqual(parseOpenRequest({ trust: 'yes', trustPath: 'D:/ws/App' }), { sessionId: null, confirmLarge: false, trust: 'yes', trustPath: 'D:/ws/App' });
  const bads = [
    'abc', [], { sessionId: '../x' }, { confirmLarge: 'yes' }, { trust: 'maybe' },
    // A "yes" must name the folder the person was shown.
    { trust: 'yes' }, { trust: 'yes', trustPath: '' }, { trust: 'yes', trustPath: 7 }, { trust: 'yes', trustPath: 'x'.repeat(4097) }
  ];
  for (const bad of bads) {
    assert.equal(parseOpenRequest(bad), null);
  }
});

// ─── handlers ───────────────────────────────────────────────────────────────

test('unknown, malformed and disabled project ids are refused for reads and opens', async () => {
  const h = createRoomHandlers(deps({ project: { enabled: false } }).d);
  for (const id of ['nope', 42, null, { id: 'app' }, 'APP', 'app']) {
    assert.deepEqual(await h.sessions(id), { ok: false, error: 'unknown-project' });
    assert.deepEqual(await h.tickets(id), { ok: false, error: 'unknown-project' });
    assert.deepEqual(await h.openTerminal(id, null, null), { ok: false, error: 'unknown-project' });
  }
});

test('tickets: returns the reader result, read from the checked folder', async () => {
  const { d } = deps();
  const seen = [];
  d.tickets = async (project) => { seen.push(project.path); return { zetahub: { ok: false, key: null, reason: 'no-key' }, local: { ok: false, reason: 'no-line' } }; };
  const res = await createRoomHandlers(d).tickets('app');
  assert.equal(res.ok, true);
  assert.equal(res.tickets.local.reason, 'no-line');
  assert.deepEqual(seen, ['D:/ws/App-real']);
});

test('tickets: a project folder that is now a link or outside the workspace reads nothing', async () => {
  const { d } = deps({ moved: true });
  let read = false;
  d.tickets = async () => { read = true; return {}; };
  assert.deepEqual(await createRoomHandlers(d).tickets('app'), { ok: false, error: 'project-moved' });
  assert.equal(read, false);
});

test('open: a new session spawns once in the real folder and stores the lead id', async () => {
  const { d, calls } = deps();
  const res = await createRoomHandlers(d).openTerminal('app', null, null);
  assert.deepEqual(res, { ok: true, agentId: 'lead--app', alreadyRunning: false, untrusted: false });
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].cwd, 'D:/ws/App-real');
  assert.equal(calls.spawn[0].untrusted, false);
  assert.deepEqual(calls.patch, [['app', { leadAgentId: 'lead--app' }]]);
});

test('trust: an untrusted project asks first, and says when Claude already trusts the folder', async () => {
  const { d, calls } = deps({ project: { trusted: false } });
  assert.deepEqual(await createRoomHandlers(d).openTerminal('app', null, null), { ok: false, error: 'needs-trust', path: 'D:/ws/App', claudeTrusts: false });
  const parent = deps({ project: { trusted: false }, claudeTrusts: true });
  assert.deepEqual(await createRoomHandlers(parent.d).openTerminal('app', null, null), { ok: false, error: 'needs-trust', path: 'D:/ws/App', claudeTrusts: true });
  assert.equal(calls.spawn.length, 0);
});

test('trust: "yes" stores the folder path and spawns trusted', async () => {
  const { d, calls } = deps({ project: { trusted: false } });
  const res = await createRoomHandlers(d).openTerminal('app', { trust: 'yes', trustPath: 'D:/ws/App' }, null);
  assert.deepEqual(calls.patch[0], ['app', { trustedPath: 'D:/ws/App', trustedRoot: ROOT }]);
  assert.equal(calls.spawn[0].untrusted, false);
  assert.equal(res.untrusted, false);
});

test('trust: a "yes" for a folder the project no longer points at asks again and stores nothing', async () => {
  const { d, calls } = deps({ project: { trusted: false } });
  const res = await createRoomHandlers(d).openTerminal('app', { trust: 'yes', trustPath: 'D:/ws/Old' }, null);
  assert.deepEqual(res, { ok: false, error: 'needs-trust', path: 'D:/ws/App', claudeTrusts: false });
  assert.deepEqual(calls.patch, []);
  assert.equal(calls.spawn.length, 0);
  assert.ok(calls.log.some((m) => m.includes('named another folder')));
});

test('trust: "yes" is not stored when the open is refused', async () => {
  const { d, calls } = deps({ project: { trusted: false } });
  const res = await createRoomHandlers(d).openTerminal('app', { trust: 'yes', trustPath: 'D:/ws/App', sessionId: '00000000-0000-4000-8000-00000000ffff' }, null);
  assert.equal(res.error, 'unknown-session');
  assert.deepEqual(calls.patch, []);
});

test('trust: "no" spawns untrusted once and stores nothing about trust', async () => {
  const { d, calls } = deps({ project: { trusted: false } });
  const res = await createRoomHandlers(d).openTerminal('app', { trust: 'no' }, null);
  assert.equal(calls.spawn[0].untrusted, true);
  assert.equal(res.untrusted, true);
  assert.ok(calls.patch.every(([, p]) => !('trustedPath' in p)));
});

test('trust: a failed save opens untrusted, as main will, and is logged', async () => {
  const { d, calls } = deps({ project: { trusted: false }, patchOk: false });
  const res = await createRoomHandlers(d).openTerminal('app', { trust: 'yes', trustPath: 'D:/ws/App' }, null);
  assert.equal(res.ok, true);
  assert.equal(res.untrusted, true, 'the panel is told the "yes" did not stick');
  assert.equal(calls.spawn[0].untrusted, true);
  assert.ok(calls.log.some((m) => m.includes('opening untrusted')));
});

test('trust: another repo in the trusted folder drops trust, Claude folder trust included, and asks again', async () => {
  const { d, calls } = deps({ trustState: 'stale' });
  const res = await createRoomHandlers(d).openTerminal('app', null, null);
  assert.deepEqual(res, { ok: false, error: 'needs-trust', path: 'D:/ws/App', claudeTrusts: false });
  assert.deepEqual(calls.revoke, [['app', 'D:/ws/App-real']]);
  assert.equal(calls.spawn.length, 0);
});

test('trust: a "yes" for a repo without a commit opens untrusted and stores nothing', async () => {
  const { d, calls } = deps({ project: { trusted: false }, repoRoot: null });
  const res = await createRoomHandlers(d).openTerminal('app', { trust: 'yes', trustPath: 'D:/ws/App' }, null);
  assert.equal(res.ok, true);
  assert.equal(res.untrusted, true);
  assert.equal(calls.spawn[0].untrusted, true);
  assert.deepEqual(calls.patch.filter(([, p]) => 'trustedPath' in p), []);
  assert.ok(calls.log.some((m) => m.includes('no root commit')));
});

test('open: a running lead is re-announced, not spawned again', async () => {
  const { d, calls } = deps({ running: ['lead--app'] });
  const res = await createRoomHandlers(d).openTerminal('app', { sessionId: ABC }, null);
  assert.deepEqual(res, { ok: true, agentId: 'lead--app', alreadyRunning: true, untrusted: false });
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.announce.length, 1);
});

test('open: two quick clicks share one spawn', async () => {
  const { d, calls } = deps();
  let release;
  d.spawnLead = (opts) => new Promise((resolve) => { calls.spawn.push(opts); release = () => resolve({ ok: true }); });
  const h = createRoomHandlers(d);
  const first = h.openTerminal('app', null, null);
  await new Promise((r) => setImmediate(r));
  const second = h.openTerminal('app', null, null);
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls.spawn.length, 1);
});

test('open: a click from a second window while opening gets its own card', async () => {
  const { d, calls } = deps();
  let release;
  d.spawnLead = (opts) => new Promise((resolve) => { calls.spawn.push(opts); release = () => resolve({ ok: true }); });
  const h = createRoomHandlers(d);
  const winA = { name: 'A' };
  const winB = { name: 'B' };
  const first = h.openTerminal('app', null, winA);
  await new Promise((r) => setImmediate(r));
  const second = h.openTerminal('app', null, winB);
  const third = h.openTerminal('app', null, winA);
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await first, await second);
  await third;
  assert.equal(calls.spawn.length, 1);
  assert.deepEqual(calls.announce.map((a) => a[3]), [winB], 'only the other window is announced; the spawn announced to A');
});

test('open: a different request while one is opening is busy', async () => {
  const { d, calls } = deps();
  let release;
  d.spawnLead = (opts) => new Promise((resolve) => { calls.spawn.push(opts); release = () => resolve({ ok: true }); });
  const h = createRoomHandlers(d);
  const first = h.openTerminal('app', null, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.openTerminal('app', { sessionId: ABC }, null), { ok: false, error: 'busy' });
  release();
  assert.equal((await first).ok, true);
});

test('open: a large session asks first, then resumes once confirmed', async () => {
  const { d, calls } = deps();
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.openTerminal('app', { sessionId: BIG }, null), { ok: false, error: 'large-session', contextTokens: 150_000 });
  assert.deepEqual(await h.openTerminal('app', { sessionId: NULLSIZE }, null), { ok: false, error: 'large-session', contextTokens: null });
  assert.equal(calls.spawn.length, 0);
  assert.equal((await h.openTerminal('app', { sessionId: BIG, confirmLarge: true }, null)).ok, true);
  assert.equal(calls.spawn[0].resumeSessionId, BIG);
});

test('open: bad requests, unknown sessions and a moved folder never spawn', async () => {
  const { d, calls } = deps();
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.openTerminal('app', { sessionId: '../x' }, null), { ok: false, error: 'invalid-request' });
  assert.deepEqual(await h.openTerminal('app', { sessionId: '00000000-0000-4000-8000-00000000ffff' }, null), { ok: false, error: 'unknown-session' });
  const moved = createRoomHandlers(deps({ moved: true }).d);
  assert.deepEqual(await moved.openTerminal('app', null, null), { ok: false, error: 'project-moved' });
  assert.equal(calls.spawn.length, 0);
});

test('open: spawn failures map to codes; the raw error is only logged', async () => {
  const notFound = deps({ spawnResult: { ok: false, resumeNotFound: true } });
  assert.deepEqual(await createRoomHandlers(notFound.d).openTerminal('app', { sessionId: ABC }, null), { ok: false, error: 'session-not-found' });
  assert.deepEqual(notFound.calls.patch, []);

  const failed = deps({ spawnResult: { ok: false, error: 'cwd does not exist: C:\\Users\\me\\secret' } });
  assert.deepEqual(await createRoomHandlers(failed.d).openTerminal('app', null, null), { ok: false, error: 'spawn-failed' });
  assert.ok(failed.calls.log.some((m) => m.includes('C:\\Users\\me\\secret')));
});

test('open: a "yes" whose spawn failed is undone, Claude folder trust included, so the next open asks again', async () => {
  const failed = deps({ project: { trusted: false }, spawnResult: { ok: false, error: 'boom' } });
  const h = createRoomHandlers(failed.d);
  assert.deepEqual(await h.openTerminal('app', { trust: 'yes', trustPath: 'D:/ws/App' }, null), { ok: false, error: 'spawn-failed' });
  assert.deepEqual(failed.calls.patch, [['app', { trustedPath: 'D:/ws/App', trustedRoot: ROOT }]]);
  assert.deepEqual(failed.calls.revoke, [['app', 'D:/ws/App-real']]);

  const already = deps({ spawnResult: { ok: false, error: 'boom' } });
  await createRoomHandlers(already.d).openTerminal('app', null, null);
  assert.deepEqual(already.calls.patch, [], 'trust given earlier is not touched by a failed spawn');
  assert.deepEqual(already.calls.revoke, []);
});

test('trust: a git failure asks again but keeps the stored trust', async () => {
  const { d, calls } = deps({ trustState: 'unknown' });
  const res = await createRoomHandlers(d).openTerminal('app', null, null);
  assert.equal(res.error, 'needs-trust');
  assert.deepEqual(calls.revoke, []);
  assert.ok(calls.log.some((m) => m.includes('trust kept')));
});

test('open: a throwing spawn is reported, and the next click can try again', async () => {
  const { d, calls } = deps();
  let throwOnce = true;
  d.spawnLead = async (opts) => {
    calls.spawn.push(opts);
    if (throwOnce) { throwOnce = false; throw new Error('boom'); }
    return { ok: true };
  };
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.openTerminal('app', null, null), { ok: false, error: 'spawn-failed' });
  assert.equal((await h.openTerminal('app', null, null)).ok, true);
  assert.equal(calls.spawn.length, 2);
});

test('close: kills a running lead, no-op otherwise, works after the project is disabled', async () => {
  const { d, calls } = deps({ running: ['lead--app'], project: { enabled: false } });
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.closeTerminal('app'), { ok: true, done: true });
  assert.deepEqual(calls.kill, ['lead--app']);
  assert.deepEqual(calls.archive, [], 'killLead archives itself; no second archive');
  assert.deepEqual(await h.closeTerminal('app'), { ok: true, done: true });
  assert.deepEqual(calls.kill, ['lead--app']);
  assert.deepEqual(await h.closeTerminal('nope'), { ok: false, error: 'unknown-project' });
});

test('close: a lead that exited on its own still has its card archived, so the room is usable again', async () => {
  const { d, calls } = deps({ running: [] });
  assert.deepEqual(await createRoomHandlers(d).closeTerminal('app'), { ok: true, done: true });
  assert.deepEqual(calls.kill, [], 'nothing to kill');
  assert.deepEqual(calls.archive, ['lead--app']);
});

test('close: during a slow open it waits, then stops the new process', async () => {
  const { d, calls } = deps();
  let release;
  d.spawnLead = (opts) => new Promise((resolve) => { calls.spawn.push(opts); release = () => { d.isRunning = (id) => id === 'lead--app' && !calls.kill.includes(id); resolve({ ok: true }); }; });
  const h = createRoomHandlers(d);
  const opening = h.openTerminal('app', null, null);
  await new Promise((r) => setImmediate(r));
  const closing = h.closeTerminal('app');
  release();
  await opening;
  assert.deepEqual(await closing, { ok: true, done: true });
  assert.deepEqual(calls.kill, ['lead--app']);
});

test('close: a failed kill is a code, the detail is logged', async () => {
  const { d, calls } = deps({ running: ['lead--app'], killFails: true });
  assert.deepEqual(await createRoomHandlers(d).closeTerminal('app'), { ok: false, error: 'stop-failed' });
  assert.ok(calls.log.some((m) => m.includes('EPERM')));
});

// ─── forget trust (ADR 0012) ─────────────────────────────────────────────────

test('forget trust: drops stored and Claude trust for the resolved folder', async () => {
  const { d, calls } = deps();
  assert.deepEqual(await createRoomHandlers(d).forgetTrust('app'), { ok: true, done: true });
  assert.deepEqual(calls.forget, [['app', 'D:/ws/App-real']]);
});

test('forget trust: a moved folder still drops the stored trust', async () => {
  const { d, calls } = deps({ moved: true });
  assert.deepEqual(await createRoomHandlers(d).forgetTrust('app'), { ok: true, done: true });
  assert.deepEqual(calls.forget, [['app', null]]);
});

test('forget trust: refused while the lead runs, nothing dropped', async () => {
  const { d, calls } = deps({ running: ['lead--app'] });
  assert.deepEqual(await createRoomHandlers(d).forgetTrust('app'), { ok: false, error: 'busy' });
  assert.deepEqual(calls.forget, []);
});

test('forget trust: refused while an open is in flight', async () => {
  const { d, calls } = deps();
  let release;
  d.spawnLead = (opts) => new Promise((resolve) => { calls.spawn.push(opts); release = () => resolve({ ok: true }); });
  const h = createRoomHandlers(d);
  const opening = h.openTerminal('app', null, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.forgetTrust('app'), { ok: false, error: 'busy' });
  release();
  await opening;
  assert.deepEqual(calls.forget, []);
});

test('forget trust: an open while trust is being dropped waits for the person to retry', async () => {
  const { d, calls } = deps();
  let release;
  d.forgetTrust = (p, cwd) => new Promise((resolve) => { calls.forget.push([p.id, cwd]); release = () => resolve(true); });
  const h = createRoomHandlers(d);
  const forgetting = h.forgetTrust('app');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.openTerminal('app', null, null), { ok: false, error: 'busy' });
  assert.equal(calls.spawn.length, 0);
  release();
  assert.deepEqual(await forgetting, { ok: true, done: true });
});

// ADR 0017: Restore team and a card restart reach the lead through pty:spawn, outside the room handlers.
test('forget trust: a pty spawn of the lead during the forget is refused and starts nothing', async () => {
  const { d, calls } = deps();
  let release;
  d.forgetTrust = (p, cwd) => new Promise((resolve) => { calls.forget.push([p.id, cwd]); release = () => resolve(true); });
  const h = createRoomHandlers(d);
  const forgetting = h.forgetTrust('app');
  await new Promise((r) => setImmediate(r));
  let spawned = false;
  const res = await spawnUnderLeadLock(d.leadLock, { id: 'lead--app', hiveId: 'lead--app' }, async () => { spawned = true; return { ok: true }; });
  assert.deepEqual(res, { ok: false, error: LEAD_BUSY_ERROR });
  assert.equal(spawned, false);
  release();
  assert.deepEqual(await forgetting, { ok: true, done: true });
  assert.equal(d.leadLock.holder('lead--app'), null);
});

test('forget trust: refused while a pty spawn of the lead runs, nothing dropped', async () => {
  const { d, calls } = deps();
  let release;
  const spawning = spawnUnderLeadLock(d.leadLock, { id: 'lead--app', hiveId: 'lead--app' }, () => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
  assert.deepEqual(await createRoomHandlers(d).forgetTrust('app'), { ok: false, error: 'busy' });
  assert.deepEqual(calls.forget, []);
  release();
  await spawning;
});

test('open: busy while a pty spawn of the lead runs, no second process', async () => {
  const { d, calls } = deps();
  let release;
  const spawning = spawnUnderLeadLock(d.leadLock, { id: 'lead--app', hiveId: 'lead--app' }, () => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
  assert.deepEqual(await createRoomHandlers(d).openTerminal('app', null, null), { ok: false, error: 'busy' });
  assert.equal(calls.spawn.length, 0);
  release();
  await spawning;
});

test('open: holds the lead while it spawns and frees it after, also when the spawn throws', async () => {
  const { d } = deps();
  let release;
  d.spawnLead = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const h = createRoomHandlers(d);
  const opening = h.openTerminal('app', null, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(d.leadLock.holder('lead--app'), 'open');
  release();
  assert.equal((await opening).ok, true);
  assert.equal(d.leadLock.holder('lead--app'), null);

  const { d: d2 } = deps();
  d2.spawnLead = async () => { throw new Error('EAGAIN'); };
  assert.deepEqual(await createRoomHandlers(d2).openTerminal('app', null, null), { ok: false, error: 'spawn-failed' });
  assert.equal(d2.leadLock.holder('lead--app'), null);
});

test('forget trust: frees the lead after a failed or throwing forget', async () => {
  const { d } = deps({ forgetOk: false });
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.forgetTrust('app'), { ok: false, error: 'forget-failed' });
  assert.equal(d.leadLock.holder('lead--app'), null);
  d.forgetTrust = async () => { throw new Error('EBUSY'); };
  assert.deepEqual(await h.forgetTrust('app'), { ok: false, error: 'forget-failed' });
  assert.equal(d.leadLock.holder('lead--app'), null);
});

test('forget trust: an untrusted project leaves Claude\'s own folder trust alone', async () => {
  const { d, calls } = deps({ project: { trusted: false } });
  assert.deepEqual(await createRoomHandlers(d).forgetTrust('app'), { ok: true, done: true });
  assert.deepEqual(calls.forget, []);
});

test('forget trust: a part not saved is a code, and the room can retry', async () => {
  const { d, calls } = deps({ forgetOk: false });
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.forgetTrust('app'), { ok: false, error: 'forget-failed' });
  d.forgetTrust = async (p, cwd) => { calls.forget.push([p.id, cwd]); return true; };
  assert.deepEqual(await h.forgetTrust('app'), { ok: true, done: true });
  assert.equal(calls.forget.length, 2);
});

test('forget trust: a throw is a code, the detail is logged, and the room is not left locked', async () => {
  const { d, calls } = deps();
  d.forgetTrust = async () => { throw new Error('EBUSY ~/.claude.json'); };
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.forgetTrust('app'), { ok: false, error: 'forget-failed' });
  assert.ok(calls.log.some((m) => m.includes('EBUSY')));
  assert.equal((await h.openTerminal('app', null, null)).ok, true, 'opens work again');
});

test('forget trust: a second forget while one runs is refused', async () => {
  const { d, calls } = deps();
  let release;
  d.forgetTrust = (p, cwd) => new Promise((resolve) => { calls.forget.push([p.id, cwd]); release = () => resolve(true); });
  const h = createRoomHandlers(d);
  const first = h.forgetTrust('app');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.forgetTrust('app'), { ok: false, error: 'busy' });
  release();
  assert.deepEqual(await first, { ok: true, done: true });
  assert.equal(calls.forget.length, 1);
});

test("forget trust: never uses main's own revoke, which drops stored trust first", async () => {
  const { d, calls } = deps();
  await createRoomHandlers(d).forgetTrust('app');
  assert.deepEqual(calls.revoke, []);
});

test('forget trust: an unknown or invalid id is refused; a disabled project can still forget', async () => {
  const { d, calls } = deps({ project: { enabled: false } });
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.forgetTrust('nope'), { ok: false, error: 'unknown-project' });
  assert.deepEqual(await h.forgetTrust({ id: 'app' }), { ok: false, error: 'unknown-project' });
  assert.deepEqual(await h.forgetTrust('app'), { ok: true, done: true });
  assert.equal(calls.forget.length, 1);
});

test('read errors become a code, not a throw', async () => {
  const { d } = deps();
  d.sessions.list = async () => { throw new Error('EACCES D:/secret/path'); };
  assert.deepEqual(await createRoomHandlers(d).sessions('app'), { ok: false, error: 'read-failed' });
});

// ─── wiring (source scan, like root-guard.test.cjs) ─────────────────────────

test('preload sends only a project id and a request object for room calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  const calls = src.match(/invoke\('room:[A-Za-z]+'[^)]*\)/g) ?? [];
  assert.deepEqual(calls.sort(), [
    "invoke('room:closeTerminal', projectId)",
    "invoke('room:forgetTrust', projectId)",
    "invoke('room:openTerminal', projectId, request ?? null)",
    "invoke('room:sessions', projectId)",
    "invoke('room:tickets', projectId)"
  ]);
});

test('wiring: spawn core decides lead trust and applies the posture; automation honours the gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /const lead = leadIdOfSpawn\(opts\.id, opts\.hive\?\.id\);\s*if \(!lead\.ok\) return \{ ok: false, error: lead\.error \};/);
  assert.match(src, /leadSnapshot = await snapshotWithin\(LEAD_TRUST_WAIT_MS\);\s*trustedLeadCwd = await roomWiring\.trustedLeadFolder\(lead\.leadId, opts\.cwd, leadSnapshot\?\.projects \?\? null\);\s*if \(!trustedLeadCwd\) opts\.untrusted = true;/);
  // ADR 0015: the lead's --agent is main's answer from the same snapshot, on every lead spawn.
  assert.match(src, /if \(opts\.hive\) opts\.hive = \{ \.\.\.opts\.hive, provider \};\s*\/\/[^\n]*\n\s*if \(lead\.leadId && claudeProvider\) \{\s*opts\.args = withLeadAgentArgs\(opts\.args \?\? \[\], await leadAgentFor\(lead\.leadId, opts\.cwd, opts\.untrusted !== true, leadSnapshot\)\);/);
  assert.match(src, /if \(trustedLeadCwd && opts\.untrusted !== true && !\(await roomWiring\.stillLeadFolder\(opts\.cwd, trustedLeadCwd\)\)\) \{\s*return \{ ok: false/);
  assert.match(src, /if \(claudeProvider && opts\.untrusted === true\) opts\.args = withoutClaudeBypassArgs\(opts\.args \?\? \[\]\);/);
  assert.match(src, /if \(claudeProvider && spawnPosture\(opts\.untrusted === true, false\)\.preAcceptTrust\) \{\s*try \{ ensureClaudePermissionsAccepted/);
  assert.match(src, /argsWithAutoModeFlag\(opts\.args \?\? \[\], spawnPosture\(opts\.untrusted === true, !!cfg\.autoMode\)\.autoMode, provider\)/);
  // The gate: held after an untrusted spawn, released by a real turn and by teardown, read by both automations.
  // Held only where Claude will show a prompt: not in a folder Claude already trusts.
  assert.match(src, /const guardTrustPrompt = claudeProvider && opts\.untrusted === true && \(!opts\.cwd \|\| await roomWiring\.leadMayMeetTrustPrompt\(opts\.cwd\)\);[\s\S]*?const hookAgentId = opts\.hive\?\.id;\s*if \(hookAgentId \|\| guardTrustPrompt\) opts\.env = \{ \.\.\.\(opts\.env \?\? \{\}\), HIVE_SPAWN_TOKEN: spawnToken \};\s*const res = ptyManager\.spawn\(opts, owner\);\s*if \(res\.ok && hookAgentId\) spawnTokens\.issue\(hookAgentId, spawnToken\);\s*if \(res\.ok && guardTrustPrompt\) \{\s*trustPromptGate\.hold\(leadId, spawnToken\);\s*spawnTokenByPty\.set\(opts\.id, spawnToken\);/);
  // ADR 0010: one token per spawn, minted before hive provisioning (the proxy sidecar needs it), checked on every hook.
  assert.match(src, /const leadId = opts\.hive\?\.id \?\? opts\.id;\s*\/\/[^\n]*\n\s*const spawnToken = spawnTokens\.next\(\);/);
  assert.match(src, /extraWritableDirs: [^\n]*,\s*spawnToken\s*\}/);
  assert.match(src, /\(agentId, spawnToken\) => spawnTokens\.check\(agentId, spawnToken\)\s*\);/);
  assert.match(src, /\(agentId, event, message, spawnToken\) => \{\s*if \(agentId && hookProvesTurn\(event\)\) trustPromptGate\.releaseOnTurn\(agentId, spawnToken\);/);
  assert.match(src, /const spawnToken = spawnTokenByPty\.get\(id\);\s*spawnTokenByPty\.delete\(id\);\s*if \(spawnToken\) trustPromptGate\.release\(agentId \?\? id, spawnToken\);/);
  assert.match(src, /a\?\.archived \|\| trustPromptGate\.blocks\(agentId\)\) continue;/);
  assert.match(src, /trustPending: trustPromptGate\.blocks\(agentId\)/);
  assert.match(src, /const roomHandlers = createRoomHandlers\(\{/);
  assert.match(src, /registerRoomIpc\(roomHandlers\);/);
  assert.match(src, /const res = ptyManager\.kill\(agentId\);[^]*?if \(!res\.ok\) return res;\s*teardownPty\(agentId\);\s*roomWiring\.archiveLeadCard\(agentId\);/);
  const hive = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');
  assert.match(hive, /if \(control\?\.trustPending\) return \{ sent: false \};/);
  // The seed prompt waits for the gate too, and an unknown gate state counts as closed.
  assert.match(hive, /live\.status === 'blocked' \|\| control\?\.trustPending !== false\) \{\s*seeded\.current\.delete\(a\.id\);/);
});

// ─── room terminal cap (ADR 0005, Rooms-d) ─────────────────────────────────

const OTHERS = [
  { ...PROJECT, id: 'web', name: 'Web', path: 'D:/ws/Web' },
  { ...PROJECT, id: 'api', name: 'Api', path: 'D:/ws/Api' }
];

test('cap: below the cap the lead opens and counts as used', async () => {
  const { d, calls } = deps({ cap: 2, running: ['lead--web'] });
  d.projects = async () => [PROJECT, ...OTHERS];
  const res = await createRoomHandlers(d).openTerminal('app', null, null);
  assert.equal(res.ok, true);
  assert.deepEqual(calls.touch, ['lead--app']);
});

test('cap: at the cap the least recently used lead is offered, nothing spawns', async () => {
  const { d, calls } = deps({ cap: 2, running: ['lead--web', 'lead--api'], lastUsed: { 'lead--web': 200, 'lead--api': 100 } });
  d.projects = async () => [PROJECT, ...OTHERS];
  assert.deepEqual(await createRoomHandlers(d).openTerminal('app', null, null),
    { ok: false, error: 'room-cap', cap: 2, closeProjectId: 'api', closeName: 'Api' });
  assert.equal(calls.spawn.length, 0);
});

test('cap: a lead whose project is gone does not count; a running lead re-opens at the cap', async () => {
  const { d, calls } = deps({ cap: 1, running: ['lead--gone'] });
  d.projects = async () => [PROJECT, ...OTHERS];
  assert.equal((await createRoomHandlers(d).openTerminal('app', null, null)).ok, true);
  const full = deps({ cap: 1, running: ['lead--app', 'lead--web'] });
  full.d.projects = async () => [PROJECT, ...OTHERS];
  const res = await createRoomHandlers(full.d).openTerminal('app', null, null);
  assert.equal(res.alreadyRunning, true);
  assert.deepEqual(full.calls.touch, ['lead--app']);
  assert.equal(calls.log.some((m) => m.includes('offering')), false);
});

test('cap: opens still in flight count, and with no live lead to offer the answer is busy', async () => {
  const { d } = deps({ cap: 1 });
  d.projects = async () => [PROJECT, ...OTHERS];
  let release;
  d.spawnLead = (opts) => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const h = createRoomHandlers(d);
  const first = h.openTerminal('web', null, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.openTerminal('app', null, null), { ok: false, error: 'busy' });
  release();
  assert.equal((await first).ok, true);
});

test('cap: two opens at once with one slot left: the first opens, only the second is refused', async () => {
  const { d, calls } = deps({ cap: 1 });
  d.projects = async () => [PROJECT, ...OTHERS];
  const h = createRoomHandlers(d);
  const [a, b] = await Promise.all([h.openTerminal('web', null, null), h.openTerminal('app', null, null)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(calls.spawn.length, 1);
});

test('close: the idle re-check runs right before the kill; false leaves the lead running', async () => {
  const { d, calls } = deps({ running: ['lead--app'] });
  const h = createRoomHandlers(d);
  assert.deepEqual(await h.closeTerminal('app', () => false), { ok: false, error: 'busy' });
  assert.deepEqual(calls.kill, []);
  assert.deepEqual(await h.closeTerminal('app', () => true), { ok: true, done: true });
  assert.deepEqual(calls.kill, ['lead--app']);
});

// ADR 0017: every main door that can start a lead shares the room's lock; the room open's own spawn does not lock twice.
test('wiring: every spawn core call that can start a lead holds the lead lock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  // The room open already holds `open` when it spawns; a worker id is never a lead id.
  const exempt = new Set(['{ ...opts, hive: { ...opts.hive } }, owner', 'spawnOpts, liveWebContents()']);
  const calls = [];
  for (const m of src.matchAll(/spawnAgentCore\(((?:[^()\n]|\([^()\n]*\))*)\)/g)) {
    const args = m[1];
    if (args.startsWith('opts: AgentSpawnOptions')) continue;
    calls.push(args);
    if (exempt.has(args)) continue;
    // The lock and the call it guards sit within a few lines of each other.
    const before = src.slice(Math.max(0, m.index - 200), m.index);
    assert.ok(before.includes('spawnUnderLeadLock(roomWiring.leadLock, '), `spawnAgentCore(${args}) is not behind the lead lock`);
  }
  // A new call fails here until someone decides whether it can start a lead.
  assert.equal(calls.length, 5, `spawn core calls: ${calls.join(' | ')}`);
  assert.match(src, /leadLock: roomWiring\.leadLock,/);
});

test('wiring: room:closeTerminal from IPC never passes a guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/roomIpc.ts'), 'utf8');
  assert.ok(src.includes("ipcMain.handle('room:closeTerminal', (_evt, projectId: unknown) => handlers.closeTerminal(projectId));"));
});
