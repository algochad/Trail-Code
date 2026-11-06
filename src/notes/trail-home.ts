/**
 * `~/.trail` on its own, so a hook's fast path (the trace layer, `trail keep`'s
 * check before a shell command) can find it without loading notes/home.ts and
 * the front-matter parser that file needs to count learnings.
 */
import { join, resolve } from "node:path";
import { userHome } from "../util/home.js";

/** `~/.trail`, or `$TRAIL_HOME`. */
export function trailHome(env: NodeJS.ProcessEnv = process.env, home: string = userHome()): string {
  return env.TRAIL_HOME ? resolve(env.TRAIL_HOME) : join(home, ".trail");
}
