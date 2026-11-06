/**
 * Self-maintenance: keeping an installed graft, and the wiring it wrote, current.
 *
 * Two independent kinds of staleness, both invisible to the user today:
 *
 *   1. **Binary staleness** — they installed once and never upgraded. `graft
 *      version` would tell them, but nobody runs it. So we keep a cached,
 *      machine-global registry answer and let every entry point surface a
 *      one-line nudge from it.
 *
 *   2. **Wiring staleness** — `graft init` copies hooks, shims, skill text and
 *      rule files INTO the repo. `npm i -g` replaces the binary but touches none
 *      of them, so a repo wired by 0.7 keeps 0.7's prompts and 0.7's hook
 *      timeouts forever (see the comment on `promptAskTimeout`, which exists
 *      only to work around exactly this). A version stamp written next to the
 *      graph lets any entry point notice the skew and re-run the writes.
 *
 * Everything here is fail-soft by construction: it runs inside hooks and inside
 * the MCP server's boot path, where a throw is a broken session, and it must
 * never block on the network — the registry is only ever read from cache, and
 * the refresh happens in a detached child.
 *
 * Called from all three hosts' entry points so no editor is left out:
 *   • Claude Code   — `session-start` hook (src/claude/hooks.ts)
 *   • Cursor/Codex  — MCP server boot (src/mcp/server.ts), and any CLI command
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, cacheDir } from './util/state.js';
import { HOSTS, hostRelPath } from './hosts/registry.js';
import { markersFor } from './hosts/sections.js';
import { readCurrentVersion } from './cli-meta.js';

/**
 * The version of the graft package this code was loaded from.
 *
 * Resolved from *this* module rather than the caller's: `readCurrentVersion`
 * looks one level up from the module URL it's given, which lands on the package
 * root for `dist/upkeep.js` but misses entirely for `dist/claude/hooks.js` and
 * `dist/mcp/server.js`. Every caller asking here instead of passing its own
 * `import.meta.url` is what keeps the hook and the MCP server from reading
 * `0.0.0` and re-initing on every single session.
 */
export function runningVersion(): string {
  try { return readCurrentVersion(import.meta.url); } catch { return '0.0.0'; }
}

/* -------------------------------------------------------------------------- */
/* version comparison                                                         */
/* -------------------------------------------------------------------------- */

/** Numeric-dotted compare of the release part only (`1.2.3-beta.1` → `1.2.3`).
 * Prerelease ordering doesn't matter here: the only question either caller asks
 * is "is the thing on npm ahead of what's on disk", and a prerelease that
 * compares equal simply produces no nudge. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string | null | undefined, current: string): boolean {
  if (!candidate) return false;
  return compareVersions(candidate, current) > 0;
}


/* -------------------------------------------------------------------------- */
/* the wiring stamp                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `graft init`'s flags a refresh has to replay.
 *
 * Without these, an auto-refresh would install things the user explicitly
 * declined: someone who ran `graft init --no-global` (or `--no-hooks`, or
 * `--no-statusline`) said "keep out of `~/.codex`" / "leave my statusline
 * alone", and a later session silently writing there would be graft overriding a
 * decision rather than maintaining one. Absent from an older stamp → all true,
 * which is what plain `graft init` does.
 */
export interface WiringOpts {
  /** false → never write outside the repo (`--no-global`). */
  global: boolean;
  /** false → skip MCP server registration (`--no-mcp`). */
  mcp: boolean;
  /** false → skip hook installation (`--no-hooks`). */
  hooks: boolean;
  /** false → skip Claude Code statusLine (`--no-statusline` / GRAFT_NO_STATUSLINE). */
  statusline: boolean;
  /** `--agents auto`: the only hosts that write outside the repo (the agents installed when it ran). Absent → every wired host. */
  laptop?: string[];
}

export const DEFAULT_WIRING_OPTS: WiringOpts = { global: true, mcp: true, hooks: true, statusline: true };

/** An older stamp has no `opts`; a plain `graft init` wired everything. */
export function wiringOpts(stamp: WiringStamp | null): WiringOpts {
  return { ...DEFAULT_WIRING_OPTS, ...(stamp?.opts ?? {}) };
}

export interface WiringStamp {
  /** The graft version whose `init` wrote this repo's agent files. */
  version: string;
  /** Host ids that were wired, so a refresh re-writes exactly those and never
   * silently adopts an agent the user declined in the picker. */
  hosts: string[];
  /** The init flags to replay — see {@link WiringOpts}. */
  opts?: Partial<WiringOpts>;
  at: string;
}

/** Under `graft/.cache/`, beside the other derived state: git-ignored, per-clone,
 * and cheap to lose — a missing stamp just means one idempotent refresh. */
export function stampPath(repo: string): string {
  return join(cacheDir(repo), 'wiring-stamp.json');
}

export function readStamp(repo: string): WiringStamp | null {
  return readJson<WiringStamp>(stampPath(repo));
}

export function writeStamp(
  repo: string,
  version: string,
  hosts: string[],
  opts: Partial<WiringOpts> = {},
  at = new Date().toISOString(),
): void {
  try {
    writeJsonAtomic(stampPath(repo), {
      version,
      hosts: [...hosts].sort(),
      opts: { ...DEFAULT_WIRING_OPTS, ...opts },
      at,
    } satisfies WiringStamp);
  } catch { /* unwritable graft/ — a refresh will just be retried next session */ }
}

/**
 * Which agents this repo is *already* wired for, read off disk rather than
 * re-detected. Detection answers "which editors does this machine have"; for a
 * refresh we need "which files did a previous init actually write" — otherwise
 * installing Windsurf once would silently add graft rules to every repo.
 */
export function wiredHostIds(repo: string): string[] {
  const ids: string[] = [];
  if (existsSync(join(repo, '.trail', 'hook.cjs')) || ['graft', 'trail'].some((n) => existsSync(join(repo, '.claude', 'helpers', `${n}-hooks.cjs`)))) ids.push('claude');
  for (const host of HOSTS) {
    // Under either name: a repo on trail has trail's files and blocks.
    const wired = (['graft', 'trail'] as const).some((n) => {
      const path = join(repo, hostRelPath(host, n));
      if (!existsSync(path)) return false;
      // A shared file (AGENTS.md, GEMINI.md) counts only if graft's fenced section
      // is in it — the user may own the file for entirely unrelated reasons.
      if (host.kind === 'section') {
        try { return readFileSync(path, 'utf8').includes(markersFor(n).start); } catch { return false; }
      }
      return true;
    });
    if (wired) ids.push(host.id);
  }
  return ids;
}
