import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_WIRING_OPTS,
  compareVersions,
  isNewer,
  readStamp,
  runningVersion,
  stampPath,
  wiredHostIds,
  wiringOpts,
  writeStamp,
  type WiringOpts,
} from '../src/upkeep.js';
import { tmpRepo } from './helpers.js';

test('compareVersions orders releases numerically, not lexically', () => {
  assert.equal(compareVersions('0.9.1', '0.10.0'), -1); // the lexical trap
  assert.equal(compareVersions('0.10.0', '0.9.1'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  // Release part only: a prerelease of the same release compares equal, so it
  // never produces a nudge in either direction.
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), 0);
  // Missing segments are zeros, and garbage degrades to 0 rather than NaN.
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('x.y.z', '0.0.0'), 0);
});

test('isNewer only fires on a strictly greater candidate', () => {
  assert.equal(isNewer('0.10.0', '0.9.1'), true);
  assert.equal(isNewer('0.9.1', '0.9.1'), false);
  assert.equal(isNewer('0.9.0', '0.9.1'), false);
  assert.equal(isNewer(null, '0.9.1'), false); // failed fetch
  assert.equal(isNewer(undefined, '0.9.1'), false); // no cache yet
});

test('runningVersion resolves this package, not the caller depth', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(runningVersion(), pkg.version);
});

test('the stamp round-trips under graft/.cache/', () => {
  const repo = tmpRepo('upkeep-stamp');
  assert.equal(readStamp(repo), null);
  writeStamp(repo, '1.2.3', ['cursor', 'claude'], {}, '2026-01-01T00:00:00.000Z');
  assert.equal(stampPath(repo), join(repo, 'graft', '.cache', 'wiring-stamp.json'));
  assert.deepEqual(readStamp(repo), {
    version: '1.2.3',
    hosts: ['claude', 'cursor'], // sorted, so two inits in different picker order match
    opts: { global: true, mcp: true, hooks: true, statusline: true },
    at: '2026-01-01T00:00:00.000Z',
  });
});

test('wiringOpts defaults an older stamp to what plain `graft init` does', () => {
  assert.deepEqual(wiringOpts(null), DEFAULT_WIRING_OPTS);
  // A stamp written before flags were recorded: assume the full wiring.
  assert.deepEqual(wiringOpts({ version: '1.0.0', hosts: ['claude'], at: 'x' }), DEFAULT_WIRING_OPTS);
  // A partial record still fills the gaps.
  assert.deepEqual(
    wiringOpts({ version: '1.0.0', hosts: ['claude'], at: 'x', opts: { global: false } }),
    { global: false, mcp: true, hooks: true, statusline: true },
  );
});

test('wiredHostIds reads what init actually wrote, not what the machine has', () => {
  const repo = tmpRepo('upkeep-wired');
  assert.deepEqual(wiredHostIds(repo), [], 'unwired repo');

  mkdirSync(join(repo, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs'), '// shim');
  mkdirSync(join(repo, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'rules', 'graft.mdc'), 'rule');
  // A shared file graft does NOT own: present, but no fenced graft section.
  writeFileSync(join(repo, 'AGENTS.md'), '# my own notes\n');

  const ids = wiredHostIds(repo);
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('cursor'));
  assert.ok(!ids.includes('agents'), "a user's own AGENTS.md is not graft wiring");

  writeFileSync(join(repo, 'AGENTS.md'), '# my own notes\n\n<!-- graft:start -->\nx\n<!-- graft:end -->\n');
  assert.ok(wiredHostIds(repo).includes('agents'), 'the fenced section makes it ours');
});

