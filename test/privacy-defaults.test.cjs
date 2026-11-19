'use strict';

// This build must not contact the upstream project: no analytics and no update
// checks unless the user turns them on. config.ts imports electron, so these
// read the source, the same pattern as settings-one-save.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function defaultsBlock() {
  const src = read('src/main/config.ts');
  const start = src.indexOf('const DEFAULTS');
  assert.ok(start >= 0, 'DEFAULTS not found in config.ts');
  return src.slice(start, src.indexOf('\n};', start));
}

test('telemetry is off by default', () => {
  assert.match(defaultsBlock(), /\btelemetryEnabled:\s*false\b/);
});

test('auto-update is off by default', () => {
  assert.match(defaultsBlock(), /\bautoUpdate:\s*false\b/);
});

test('onboarding leaves usage stats unchecked', () => {
  const wizard = read('src/renderer/src/components/OnboardingWizard.tsx');
  assert.match(wizard, /\[shareStats, setShareStats\] = useState<boolean>\(false\)/);
});

test('missing or non-boolean values never turn telemetry or updates on', () => {
  const updater = read('src/main/updater.ts');
  const main = read('src/main/index.ts');
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  for (const [name, src] of [['updater.ts', updater], ['index.ts', main], ['SettingsModal.tsx', modal]]) {
    assert.doesNotMatch(src, /\b(autoUpdate|telemetryEnabled)\s*!==\s*false\b/, `${name} fails open`);
  }
});

test('without an update feed the updater makes no network call', () => {
  const updater = read('src/main/updater.ts');
  const body = (name) => {
    const start = updater.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    return updater.slice(start, start + 400);
  };
  assert.match(body('fallbackCheck'), /if \(!hasUpdateFeed\(\)\) return;/);
  assert.match(body('runCheck'), /if \(!hasUpdateFeed\(\)\)/);
  assert.match(updater, /if \(!previewPath && hasUpdateFeed\(\)\)/, 'release-notes fetch must be gated');
});

test('model catalog and settings hero are not fetched from upstream', () => {
  assert.match(read('src/main/modelCatalog.ts'), /const CATALOG_URL: string \| null = null;/);
  assert.match(read('src/main/hero.ts'), /const HERO_URL: string \| null = null;/);
});

test('the packaged app has no update feed', () => {
  const builder = read('electron-builder.yml');
  assert.match(builder, /^publish:\s*null\s*$/m);
  assert.doesNotMatch(builder, /^\s*provider:\s*github/m);
});
