'use strict';

// ADR 0015: which agent a room's lead runs as, and the args main gives its spawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { resolveMainAgent, withLeadAgentArgs, settingsAgentFrom, choosableGlobalAgents } = loadTs('src/shared/mainAgent.ts');
const { leadAgentOf, leadProjectOf } = loadTs('src/shared/roomLead.ts');
const model = loadTs('src/renderer/src/components/room/roomAgentModel.ts');

const def = (file, over = {}) => ({ file, name: file, model: null, description: null, delegates: true, ...over });
const project = (over = {}) => ({
  mainAgent: null, settingsAgent: null, agents: [def('dev'), def('lead', { delegates: false })], agentsFullyRead: true, trusted: true, ...over
});
const globals = [def('reviewer'), def('dev-global', { name: 'dev' })];

test('resolve: room choice, then the repo setting, then the hive default', () => {
  assert.deepEqual(resolveMainAgent(project(), globals), { source: 'hive' });
  assert.deepEqual(resolveMainAgent(project({ settingsAgent: 'dev' }), globals), { source: 'project-settings', name: 'dev' });
  assert.deepEqual(
    resolveMainAgent(project({ settingsAgent: 'dev', mainAgent: { scope: 'project', file: 'lead' } }), globals),
    { source: 'room', scope: 'project', file: 'lead', name: 'lead', delegates: false }
  );
  assert.equal(resolveMainAgent(project({ mainAgent: { scope: 'global', file: 'reviewer' } }), globals).source, 'room');
});

test('resolve: a gone or shadowed choice is missing, not a fallback', () => {
  const gone = resolveMainAgent(project({ settingsAgent: 'dev', mainAgent: { scope: 'project', file: 'old' } }), globals);
  assert.deepEqual(gone, { source: 'room-missing', scope: 'project', file: 'old' });
  const shadowed = resolveMainAgent(project({ mainAgent: { scope: 'global', file: 'dev-global' } }), globals);
  assert.equal(shadowed.source, 'room-missing', 'Claude would run the project agent named dev');
  assert.deepEqual(choosableGlobalAgents(project(), globals).map((a) => a.file), ['reviewer']);
  const caseShadow = resolveMainAgent(project({ agents: [def('rev', { name: 'Reviewer' })], mainAgent: { scope: 'global', file: 'reviewer' } }), globals);
  assert.equal(caseShadow.source, 'room-missing', 'names are compared without regard to case');
});

test('resolve: a folder the scan did not fully read allows no global choice', () => {
  const partial = project({ agentsFullyRead: false, mainAgent: { scope: 'global', file: 'reviewer' } });
  assert.deepEqual(choosableGlobalAgents(partial, globals), []);
  assert.deepEqual(resolveMainAgent(partial, globals), { source: 'room-missing', scope: 'global', file: 'reviewer' });
  const local = resolveMainAgent({ ...partial, mainAgent: { scope: 'project', file: 'dev' } }, globals);
  assert.equal(local.source, 'room', 'a project choice is still the repo’s own');
});

test('resolve: two files with one name are ambiguous, not a guess', () => {
  const twins = project({ agents: [def('a', { name: 'dev' }), def('b', { name: 'DEV' })], mainAgent: { scope: 'project', file: 'a' } });
  assert.deepEqual(resolveMainAgent(twins, globals), { source: 'room-ambiguous', scope: 'project', file: 'a', name: 'dev' });
  assert.deepEqual(model.leadStatus(twins, globals, false).notes, [{ key: 'room.agents.leadAmbiguous', warn: true, name: 'dev' }]);
});

test('lead args: every agent- or settings-defining flag goes; a room choice adds --agent', () => {
  const room = { source: 'room', scope: 'project', file: 'lead', name: 'lead', delegates: true };
  const replayed = [
    '--model', 'opus', '--agent', 'forged', '--agent=other', '--agents', '{"lead":{}}', '--settings', '{"agent":"x"}',
    '--settings=f.json', '--setting-sources', 'user', '--plugin-dir', 'p', '--plugin-dir=q', '--verbose'
  ];
  assert.deepEqual(withLeadAgentArgs(replayed, { source: 'hive' }), ['--model', 'opus', '--verbose']);
  assert.deepEqual(withLeadAgentArgs(replayed, { source: 'project-settings', name: 'dev' }), ['--model', 'opus', '--verbose']);
  assert.deepEqual(withLeadAgentArgs(['--agent', 'x'], room), ['--agent', 'lead']);
  assert.deepEqual(withLeadAgentArgs([], { source: 'room-missing', scope: 'project', file: 'old' }), []);
});

test('lead spawn decision: late, other folder, untrusted repo agent, and the normal case', () => {
  const p = { ...project({ mainAgent: { scope: 'project', file: 'dev' } }), id: 'app', leadAgentId: null };
  const snapshot = { workspaceRoot: 'D:/ws', projects: [p], globalAgents: globals };
  assert.equal(leadProjectOf('lead--app', snapshot), p);
  assert.equal(leadProjectOf('lead--other', snapshot), null);
  assert.equal(leadProjectOf('lead--app', null), null);
  const decide = (over) => leadAgentOf({ snapshot, project: p, cwdIsProject: true, trusted: true, ...over });
  assert.deepEqual(decide({ snapshot: null }), { agent: { source: 'hive' }, held: 'late' });
  assert.deepEqual(decide({ project: null }), { agent: { source: 'hive' }, held: 'no-project' });
  assert.deepEqual(decide({ cwdIsProject: false }), { agent: { source: 'hive' }, held: 'other-folder' });
  assert.deepEqual(decide({ trusted: false }), { agent: { source: 'hive' }, held: 'untrusted' });
  assert.deepEqual(decide({}), { agent: { source: 'room', scope: 'project', file: 'dev', name: 'dev', delegates: true }, held: null });
  const globalChoice = { ...p, mainAgent: { scope: 'global', file: 'reviewer' } };
  assert.equal(decide({ project: globalChoice, trusted: false }).agent.source, 'room', 'the user’s own agent needs no repo trust');
  assert.equal(model.leadStatus({ ...p, trusted: false }, globals, false).notes[0].key, 'room.agents.leadNeedsTrust');
});

test('settings agent: a valid name from a JSON object, else null', () => {
  assert.equal(settingsAgentFrom('{"agent":"dev"}'), 'dev');
  assert.equal(settingsAgentFrom('﻿{"agent":"dev"}'), 'dev');
  for (const text of [null, '', 'not json', '[]', '{"agent":3}', '{"agent":"a b"}', '{"agent":"../x"}', '{}']) {
    assert.equal(settingsAgentFrom(text), null, String(text));
  }
});

test('picker: default, project agents, unshadowed globals, and a stored choice that is gone', () => {
  const opts = model.leadOptions(project({ mainAgent: { scope: 'global', file: 'old' } }), globals);
  assert.deepEqual(opts.map((o) => [o.value, o.group]), [
    ['', 'default'], ['project:dev', 'project'], ['project:lead', 'project'], ['global:reviewer', 'global'], ['global:old', 'missing']
  ]);
  assert.deepEqual(model.leadRefOf('project:lead', opts), { scope: 'project', file: 'lead' });
  assert.equal(model.leadRefOf('', opts), null);
  assert.equal(model.leadRefOf('global:old', opts), null, 'a missing choice cannot be stored again');
  assert.equal(model.leadRefOf('global:dev-global', opts), null, 'a value no option has');
});

test('status: default label, warnings and the next-start note', () => {
  assert.equal(model.leadStatus(project(), globals, false).defaultLabelKey, 'room.agents.leadDefaultHive');
  assert.equal(model.leadStatus(project({ settingsAgent: 'dev' }), globals, false).defaultLabelKey, 'room.agents.leadDefaultSettings');
  const noDelegate = model.leadStatus(project({ mainAgent: { scope: 'project', file: 'lead' } }), globals, true);
  assert.deepEqual(noDelegate.notes.map((n) => n.key), ['room.agents.leadNoDelegate', 'room.agents.leadNextStart']);
  const missing = model.leadStatus(project({ mainAgent: { scope: 'project', file: 'old' } }), globals, false);
  assert.deepEqual(missing.notes, [{ key: 'room.agents.leadMissing', warn: true, name: 'old' }]);
});

test('lead badge: the room choice, else the project agent the repo setting names', () => {
  const agents = project().agents;
  const room = resolveMainAgent(project({ mainAgent: { scope: 'project', file: 'lead' } }), globals);
  assert.deepEqual(agents.map((a) => model.isLeadRow(room, a)), [false, true]);
  const settings = resolveMainAgent(project({ settingsAgent: 'dev' }), globals);
  assert.deepEqual(agents.map((a) => model.isLeadRow(settings, a)), [true, false]);
  const global = resolveMainAgent(project({ mainAgent: { scope: 'global', file: 'reviewer' } }), globals);
  assert.deepEqual(agents.map((a) => model.isLeadRow(global, a)), [false, false]);
});

test('every lead and agent-file string exists in every locale', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');
  const keys = [
    'leadLabel', 'leadDefaultHive', 'leadDefaultSettings', 'leadOptionGlobal', 'leadOptionMissing',
    'leadMissing', 'leadAmbiguous', 'leadNeedsTrust', 'leadNoDelegate', 'leadNextStart', 'leadBadge', 'open', 'openTitle', 'trash', 'trashTitle', 'trashBody',
    'trashLead', 'trashCancel', 'trashConfirm'
  ];
  const errors = ['invalid-request', 'unknown-agent', 'not-a-file', 'open-failed', 'trash-failed'];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const agents = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).room.agents;
    for (const key of keys) assert.equal(typeof agents[key], 'string', `${file} room.agents.${key}`);
    for (const code of errors) assert.equal(typeof agents.errors?.[code], 'string', `${file} room.agents.errors.${code}`);
  }
});
