/**
 * The start every hook event shares, kept small so an event that needs little can run without loading all of
 * hooks.ts: the payload on stdin, the project folder, and the checks that say this copy should stay quiet.
 */
import { readFileSync } from 'node:fs';
import { adoptRepoBrand } from '../brand.js';
import { hostsWiredForTrail } from '../hosts/registry.js';
import { userHome } from '../util/home.js';
import { globalCopyCovers } from './hook-layers.js';

/** The hook's payload: JSON on stdin (GRAFT_TEST_STDIN in a test), or {} when there is none or it isn't an object. */
export function readStdin(): any {
  const seam = process.env.GRAFT_TEST_STDIN;
  const raw = seam !== undefined ? seam : safeReadFd0();
  try {
    const input = JSON.parse(raw);
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  } catch { return {}; }
}
function safeReadFd0(): string { try { return readFileSync(0, 'utf8'); } catch { return ''; } }

export function projectDir(input: any): string {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

/**
 * The payload and project folder for `event`, or null when the hook should do nothing: trail's own headless Claude
 * calls set TRAIL_NO_HOOKS, and a repo copy stands down when the `~/.claude` copy answers the same event (Claude Code
 * runs both; Copilot CLI runs only the repo's, so the payload decides first).
 */
export function beginHook(event: string): { input: any; dir: string } | null {
  if (process.env.TRAIL_NO_HOOKS === '1') return null;
  const input = readStdin();
  if (globalCopyCovers(event, process.argv[1], userHome(), process.env, input)) return null;
  return { input, dir: projectDir(input) };
}

/** Name the repo's brand (trail or graft) from how it was wired, before the event speaks. */
export function adoptBrand(dir: string): void {
  adoptRepoBrand(dir, process.env, hostsWiredForTrail);
}
