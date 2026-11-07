/**
 * What every entry point asks of `./upkeep.ts`. Read-only: a hook or the MCP server never writes wiring, settings,
 * helper scripts, status lines or skills. Only `trail init` (or another command the person runs) does.
 */
import { compareVersions, readStamp, wiredHostIds } from './upkeep.js';
import { pluginMode } from './brand.js';

export interface UpkeepResult {
  /** Lines worth showing the agent/user, already formatted. Usually empty. */
  lines: string[];
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
  // Plugin mode: the plugin owns the hooks, and `trail init` would add a second set beside them.
  if (pluginMode()) return { lines };
  try {
    const stamp = readStamp(repo);
    if (stamp && compareVersions(stamp.version, current) < 0 && wiredHostIds(repo).length > 0)
      lines.push(`· this repo's agent wiring was written by ${stamp.version}, this is ${current}: run trail init to refresh it`);
  } catch { /* never worth breaking a session for */ }
  return { lines };
}
