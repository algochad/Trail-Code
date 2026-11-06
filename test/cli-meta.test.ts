import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve, sep } from 'node:path';
import {
  resolvePackageJsonPath,
  readCurrentVersion,
  isRunningViaNpx,
} from '../src/cli-meta.js';

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  const found = resolvePackageJsonPath(fakeDistCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  const found = resolvePackageJsonPath(fakeSrcCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});

// --- isRunningViaNpx: pure path heuristic ---
//
// Built with `join` rather than a `/`-separated literal so the path carries the
// platform separator: `fileURLToPath` hands back `…\_npx\…` on Windows, where the
// original `includes("/_npx/")` was always false and `graft upgrade` would have run
// `npm install -g` on top of an npx invocation. On posix this is the identity case.

test('isRunningViaNpx detects an npx cache path', () => {
  const npxPath = pathToFileURL(
    join(sep, 'Users', 'x', '.npm', '_npx', 'abc123', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(npxPath), true);
});

test('isRunningViaNpx is false for a regular global install', () => {
  const globalPath = pathToFileURL(
    join(sep, 'usr', 'local', 'lib', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(globalPath), false);
});

// --- npm failures `upgrade` recovers from: parsed from npm's own error block ---

const ENOTEMPTY = `npm error code ENOTEMPTY
npm error syscall rename
npm error path /Users/a/.nvm/versions/node/v22.21.1/lib/node_modules/@trailhq/trail-code
npm error dest /Users/a/.nvm/versions/node/v22.21.1/lib/node_modules/@trailhq/.trail-code-HDYWMwwn
npm error errno -66`;

