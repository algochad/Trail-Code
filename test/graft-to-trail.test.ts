/**
 * graft users moving to trail: nothing moves a repo in the background (a hook
 * never writes wiring), and nothing reads past sessions on the way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { tmpRepo } from './helpers.js';

process.env.GRAFT_MCP_NPX = '1';
process.env.TRAIL_NO_FETCH = '1';
delete process.env.GRAFT_NO_TRAIL_SWITCH;

/** A folder holding a `trail` executable, for PATH. */
function binWith(name: string): string {
  const bin = mkdtempSync(join(tmpdir(), `bin-${name}-`));
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, name), 0o755);
  return bin;
}

test('moving to trail never reads past sessions in the background: there is no hidden command left to do it', { skip: process.platform === 'win32' ? 'shebang stand-in' : false }, () => {
  const repo = tmpRepo('move-no-past-read');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const home = mkdtempSync(join(tmpdir(), 'move-no-past-read-home-'));
  const projects = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  for (const [id, at] of [['a1', '2026-10-01T10:00:00Z'], ['b2', '2026-10-03T10:00:00Z']])
    writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: repo, timestamp: at, message: { role: 'user', content: 'always run the linter before pushing' } }) + '\n');
  const bin = mkdtempSync(join(tmpdir(), 'move-no-past-read-bin-'));
  const asked = join(bin, 'asked');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo 9.9.9; exit 0; }\ntouch "${asked}"\necho '{"is_error":false,"structured_output":{"findings":[]}}'\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'src', 'bin', 'trail.ts'), '_trail-past-read', repo], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, '.trail'), PATH: `${bin}${delimiter}${process.env.PATH}`, DO_NOT_TRACK: '1', TRAIL_NO_FETCH: '1', CLAUDECODE: undefined },
  });
  assert.notEqual(r.status, 0, 'not a command any more');
  assert.ok(!existsSync(asked), 'Claude Code was never asked');
});
