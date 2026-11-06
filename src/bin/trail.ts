#!/usr/bin/env node
// The `trail` command. Same code as `graft`, with trail's command layout.
// The Node check runs before the rest loads (node-version.ts says why).
import { nodeTooOld } from "../node-version.js";

const tooOld = nodeTooOld("trail", "@trailhq/trail-code");
if (tooOld) {
  console.error(tooOld);
  process.exit(1);
}
// V8's compile cache keeps what it compiled of trail's own files between runs (a hook starts a process per call).
// Kept in the trail home, the one place trail writes to besides the repo. Node 22.1 and later; a no-op before.
(await import("../util/compile-cache.js")).useCompileCache();
const { setBrand } = await import("../brand.js");
setBrand("trail");
if (process.argv[2] === "hook") {
  // A plugin's hook: nothing of the CLI is loaded (see claude/hook-entry.ts).
  await (await import("../claude/hook-entry.js")).runHookCommand(process.argv[3]);
} else {
  await import("../cli.js");
}
