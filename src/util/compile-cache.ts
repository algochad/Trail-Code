import * as nodeModule from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { userHome } from "./home.js";

/**
 * Turn on Node's on-disk compile cache for this process and the node children it starts (they inherit
 * NODE_COMPILE_CACHE), under `<trail home>/cache/node-compile`, once that folder exists. Never throws; does nothing on a Node without it.
 */
export function useCompileCache(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const enable = (nodeModule as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
    if (typeof enable !== "function" || env.NODE_DISABLE_COMPILE_CACHE) return;
    const home = env.TRAIL_HOME ? resolve(env.TRAIL_HOME) : join(userHome(env), ".trail");
    // Only where trail already lives: a run in a folder with no trail home (an init in the home folder, say) creates nothing.
    if (!existsSync(home)) return;
    enable(join(home, "cache", "node-compile"));
  } catch {
    /* a cache that can't be made is just a slower start */
  }
}
