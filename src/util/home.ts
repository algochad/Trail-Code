/**
 * Where the person's home and Claude Code's config folder are: the one place that decides.
 *
 * `HOME` (or `USERPROFILE` on Windows) comes first, so a run under a temp HOME never reaches the real one; the
 * account's passwd entry is only the last resort. `CLAUDE_CONFIG_DIR` moves Claude Code's whole config folder, and
 * `.claude.json` with it, but only for the real home: a caller that names its own `home` (a test, a scratch folder)
 * gets that home's `.claude`, whatever the environment says. Imports nothing but node builtins, because hooks load it.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The user's home: `$HOME`, else `$USERPROFILE`, else the account's. */
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Whether `home` is the environment's own home, rather than one a caller named. */
function isEnvHome(home: string | undefined, env: NodeJS.ProcessEnv): boolean {
  return home === undefined || resolve(home) === resolve(userHome(env));
}

/** Claude Code's config folder: `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`. */
export function claudeDir(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR && isEnvHome(home, env)) return resolve(env.CLAUDE_CONFIG_DIR);
  return join(home ?? userHome(env), ".claude");
}

/** Claude Code's user-level config file (user MCP servers live in it): inside `$CLAUDE_CONFIG_DIR` when that is set, else `<home>/.claude.json`. */
export function claudeJsonPath(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR && isEnvHome(home, env)) return join(resolve(env.CLAUDE_CONFIG_DIR), ".claude.json");
  return join(home ?? userHome(env), ".claude.json");
}
