/**
 * What every entry point asks of `./upkeep.ts`. Read-only: a hook or the MCP server never writes wiring, settings,
 * helper scripts, status lines or skills. Only `trail init` (or another command the person runs) does.
 */
import { trailOnPath, repoWiredForTrail } from './brand.js';
import { compareVersions, readStamp, wiredHostIds } from './upkeep.js';

export interface UpkeepResult {
  /** Lines worth showing the agent/user, already formatted. Usually empty. */
  lines: string[];
}

/**
 * Whether a repo wired as graft should move to trail: the person has the trail command and the repo is still on
 * graft's wiring. `trail upgrade` and the person move it, with `trail init`; nothing moves it in the background.
 * GRAFT_NO_TRAIL_SWITCH=1 keeps a machine on graft.
 */
export function shouldMoveToTrail(repo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GRAFT_NO_TRAIL_SWITCH === '1') return false;
  // Claude Code's wiring is what says a repo is on trail, so only a repo with it moves.
  return wiredHostIds(repo).includes('claude') && !repoWiredForTrail(repo) && trailOnPath(env);
}

/**
 * One line when this repo's agent wiring was written by an older version, saying how to refresh it. Writes nothing:
 * the old shims still find the package, so an out-of-date wiring keeps working until the person runs `trail init`.
 *
 * @param repo    the project dir
 * @param current the running version
 */
export function runUpkeep(repo: string, current: string): UpkeepResult {
  const lines: string[] = [];
  try {
    const stamp = readStamp(repo);
    if (stamp && compareVersions(stamp.version, current) < 0 && wiredHostIds(repo).length > 0)
      lines.push(`· this repo's agent wiring was written by ${stamp.version}, this is ${current}: run trail init to refresh it`);
  } catch { /* never worth breaking a session for */ }
  return { lines };
}
