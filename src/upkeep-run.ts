/**
 * The wired-up version of `./upkeep.ts` — one call every entry point makes.
 *
 * Split from `upkeep.ts` so that module stays pure and unit-testable (no init
 * writes, no spawning): this file is the only place that knows how to actually
 * re-run the wiring, and it is deliberately thin.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInit, wiringName } from './claude/init.js';
import { runHostsInit } from './hosts/init.js';
import { graftCliPath } from './claude/paths.js';
import { repoWiredForTrail, setBrand, trailOnPath } from './brand.js';
import { ensureRepoHome } from './notes/home.js';
import { ensureRepoTrail } from './notes/repo-trail.js';
import {
  formatWiringRefresh,
  reconcileWiring,
  wiredHostIds,
  type WiringOpts,
} from './upkeep.js';

export interface UpkeepResult {
  /** Lines worth showing the agent/user, already formatted. Usually empty. */
  lines: string[];
}

/**
 * Re-write the wiring for exactly the hosts a previous `init` chose here, with
 * exactly the flags it was given.
 *
 * `build: false` matters: this runs at session start and at MCP boot, and a graph
 * build there would stall the agent's first turn.
 *
 * The out-of-repo writes (`~/.codex/hooks.json`, `~/.codex/config.toml`) ARE
 * included, because nothing else would ever refresh them: no skill, rule file, or
 * MCP instruction tells an agent to run `graft init`, so leaving them out means a
 * Codex user upgrades the binary and keeps the old hook config forever. They're
 * safe to replay — `installCodexHooks` no-ops when `~/.codex` is absent, rewrites
 * only its own entry (matched on `graft-hooks.cjs`), and reports `unchanged` when
 * the bytes match. A user who declined them at init time is honoured via
 * `opts.global`/`opts.hooks`, replayed from the stamp.
 */
function rewriteWiring(repo: string, hosts: string[], opts: WiringOpts, toTrail = false): void {
  // Moving to trail: everything written from here speaks trail, the repo gets
  // its .trail/, and the hosts are rewired under trail's names.
  if (toTrail) setBrand('trail');
  // Under trail, each refresh also brings `.trail/` and its README up to date.
  if (toTrail || wiringName(repo) === 'trail') {
    const { place } = ensureRepoHome(repo);
    if (place.git) ensureRepoTrail(place.checkout);
  }
  // `opts.global` reaches the claude layer for the same reason `opts.statusline` does:
  // its `~/.claude` writes (hosts/claude-global.ts) are out-of-repo, and a user who
  // declined those at init time must keep declining them on every replay.
  // A repo set up with `trail init --no-hooks` (a plugin owns its hooks) has no shim to say it is trail's: its `.trail/` does.
  const pluginRepo = opts.hooks === false && existsSync(join(repo, '.trail'));
  if (hosts.includes('claude'))
    runInit(repo, { build: false, cliPath: graftCliPath(), statusline: opts.statusline, hooks: opts.hooks, global: opts.global && (!opts.laptop || opts.laptop.includes('claude')), ...(toTrail || pluginRepo ? { brand: 'trail' as const } : {}) });
  // The other agents move with Claude Code: their graft-named files and
  // fenced blocks are replaced by trail's (see hosts/init.ts).
  const others = hosts.filter((h) => h !== 'claude');
  if (others.length)
    runHostsInit(repo, { agents: others, global: opts.global, laptop: opts.laptop, mcp: opts.mcp, hooks: opts.hooks, ...(toTrail ? { brand: 'trail' as const } : {}) });
  // Past sessions are never read here: only `trail init`, where the person sees what was found and picks.
}

/**
 * Whether a repo wired as graft should move to trail now: the person has the
 * trail command, so they've taken the update that renames graft. Each repo
 * moves the first time a session opens in it. GRAFT_NO_TRAIL_SWITCH=1 keeps a
 * machine on graft.
 */
export function shouldMoveToTrail(repo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GRAFT_NO_TRAIL_SWITCH === '1') return false;
  // Claude Code's wiring is what says a repo is on trail, so only a repo with it moves.
  return wiredHostIds(repo).includes('claude') && !repoWiredForTrail(repo) && trailOnPath(env);
}

/**
 * @param repo    the project dir
 * @param current the running graft's version
 */
export function runUpkeep(
  repo: string,
  current: string,
): UpkeepResult {
  const lines: string[] = [];
  try {
    const refreshed = reconcileWiring(repo, current, { rewrite: rewriteWiring, toTrail: (r) => shouldMoveToTrail(r) });
    const refreshLine = formatWiringRefresh(refreshed);
    if (refreshLine) lines.push(refreshLine);
  } catch { /* fail-soft: wiring refresh is never worth breaking a session for */ }
  return { lines };
}
