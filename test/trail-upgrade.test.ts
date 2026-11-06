/** `trail upgrade` installs nothing: this fork updates through its Claude Code plugin. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { homeEnv } from "./helpers.js";

test("trail upgrade says it updates through the plugin, exits 0, and never runs npm", { skip: process.platform === "win32" }, () => {
  const bin = mkdtempSync(join(tmpdir(), "upgrade-bin-"));
  const home = mkdtempSync(join(tmpdir(), "upgrade-home-"));
  const called = join(bin, "npm-called");
  for (const n of ["npm", "npx"]) {
    writeFileSync(join(bin, n), `#!/bin/sh\ntouch "${called}"\nexit 1\n`);
    chmodSync(join(bin, n), 0o755);
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "upgrade"], {
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), TRAIL_HOME: join(home, ".trail"), PATH: `${bin}${delimiter}${process.env.PATH}`, DO_NOT_TRACK: "1", CLAUDECODE: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated through its Claude Code plugin/);
  assert.equal(existsSync(called), false, "npm was never run");
});
