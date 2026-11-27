'use strict';

// ADR 0009: agent frontmatter from repos that may not be trusted.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseAgentFrontmatter, agentDefinitionsFrom, isKnownModel, agentNameOfFile, toolsDelegate } = loadTs('src/shared/agentDefinition.ts');

const fm = (body) => `---\n${body}\n---\n# Body\n`;

test('frontmatter: plain, quoted and commented values', () => {
  assert.deepEqual(parseAgentFrontmatter(fm('name: reviewer\nmodel: sonnet # pinned\ndescription: Reviews diffs.')), {
    name: 'reviewer', model: 'sonnet', description: 'Reviews diffs.'
  });
  assert.deepEqual(parseAgentFrontmatter(fm('name: "go-dev"\ndescription: \'It\'\'s fine: "yes"\'')), {
    name: 'go-dev', description: 'It\'s fine: "yes"'
  });
  assert.deepEqual(parseAgentFrontmatter(fm('description: "say \\"hi\\" # not a comment"')), { description: 'say "hi" # not a comment' });
});

test('frontmatter: CRLF, a BOM and other keys are fine', () => {
  const text = '﻿---\r\nname: a\r\ntools: Read, Grep\r\ncolor: blue\r\nmodel: haiku\r\n---\r\nbody';
  assert.deepEqual(parseAgentFrontmatter(text), { name: 'a', tools: 'Read, Grep', model: 'haiku' });
});

test('frontmatter: anything not understood gives nothing for that key', () => {
  // No fence, a fence that never closes (a cut head), a fence not on the first line.
  assert.deepEqual(parseAgentFrontmatter('name: a\n'), {});
  assert.deepEqual(parseAgentFrontmatter('---\nname: a\nmodel: opus\n'), {});
  assert.deepEqual(parseAgentFrontmatter('\n---\nname: a\n---\n'), {});
  // Block scalars, flow collections, anchors, an unclosed quote, an empty value, an indented key.
  assert.deepEqual(parseAgentFrontmatter(fm('description: |\n  multi\n  line')), {});
  assert.deepEqual(parseAgentFrontmatter(fm('description: >-\n  folded')), {});
  assert.deepEqual(parseAgentFrontmatter(fm('model: [opus]\nname: &x a')), {});
  assert.deepEqual(parseAgentFrontmatter(fm('name: "open')), {});
  assert.deepEqual(parseAgentFrontmatter(fm('name:\nmodel:   ')), {});
  assert.deepEqual(parseAgentFrontmatter(fm('meta:\n  name: nested')), {});
});

test('frontmatter: a key given twice is dropped', () => {
  assert.deepEqual(parseAgentFrontmatter(fm('model: opus\nname: a\nmodel: haiku')), { name: 'a' });
  assert.deepEqual(parseAgentFrontmatter(fm('model: opus\nmodel: haiku\nmodel: sonnet')), {});
});

test('known models: aliases and claude ids only', () => {
  for (const ok of ['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'claude-opus-5-5', 'claude-3.5-sonnet']) assert.equal(isKnownModel(ok), true, ok);
  for (const bad of ['Opus', 'gpt-4o', 'claude-', 'claude-opus 5', `claude-${'a'.repeat(60)}`, 'claude-a-b-c-d-e-f-g-h-i-j']) assert.equal(isKnownModel(bad), false, bad);
});

test('agent names from file names', () => {
  assert.equal(agentNameOfFile('go-dev.md'), 'go-dev');
  assert.equal(agentNameOfFile('Go.MD'), 'Go');
  for (const bad of ['README.txt', '../evil.md', 'a b.md', '.md', '-x.md']) assert.equal(agentNameOfFile(bad), null, bad);
});

test('definitions: frontmatter wins when valid, else the file name; text is cleaned', () => {
  const defs = agentDefinitionsFrom([
    { file: 'b.md', head: fm('name: bad name!\nmodel: gpt-4o\ndescription: "x‮y\u0007z"') },
    { file: 'a.md', head: fm(`name: alpha\nmodel: opus\ndescription: ${'d'.repeat(300)}`) },
    { file: 'c.md', head: null },
    { file: 'skip.txt', head: fm('name: skip') },
    { file: 'a.md', head: fm('name: again') }
  ]);
  assert.deepEqual(defs.map((d) => [d.file, d.name, d.model]), [['a', 'alpha', 'opus'], ['b', 'b', null], ['c', 'c', null]]);
  assert.equal(defs[0].description.length, 200);
  assert.ok(defs[0].description.endsWith('…'));
  assert.equal(defs[1].description, 'x y z', 'bidi overrides and controls are removed');
  assert.equal(defs[2].description, null);
});

test('delegates: only a tools line without Agent or Task says no (ADR 0015)', () => {
  assert.equal(toolsDelegate(undefined), true, 'no tools line: all tools');
  assert.equal(toolsDelegate('Read, Grep, Glob, Bash'), false);
  assert.equal(toolsDelegate('Read, Agent'), true);
  assert.equal(toolsDelegate('Task'), true, 'the older name');
  assert.equal(toolsDelegate('Read, Agent(worker, reviewer)'), true);
  assert.equal(toolsDelegate('Read, AgentX'), false);
  const [readOnly, all, flow] = agentDefinitionsFrom([
    { file: 'a.md', head: fm('tools: Read, Grep') },
    { file: 'b.md', head: fm('name: b') },
    { file: 'c.md', head: fm('tools: [Read]') }
  ]);
  assert.equal(readOnly.delegates, false);
  assert.equal(all.delegates, true);
  assert.equal(flow.delegates, true, 'a line we cannot read is no warning');
});
