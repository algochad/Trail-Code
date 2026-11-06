/** The one place that says where the user's home and Claude Code's config folder are. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { claudeDir, claudeJsonPath, userHome } from "../src/util/home.js";

test("userHome is HOME, then USERPROFILE, and never the account's own while either is set", () => {
  assert.equal(userHome({ HOME: "/tmp/h", USERPROFILE: "/tmp/p" }), "/tmp/h");
  assert.equal(userHome({ USERPROFILE: "/tmp/p" }), "/tmp/p");
  assert.ok(userHome({}).length > 0, "the account's home is the last resort");
});

test("CLAUDE_CONFIG_DIR moves Claude's config folder and .claude.json for the environment's home only", () => {
  const env = { HOME: "/tmp/h", CLAUDE_CONFIG_DIR: "/tmp/cfg" };
  assert.equal(claudeDir(undefined, env), resolve("/tmp/cfg"));
  assert.equal(claudeDir("/tmp/h", env), resolve("/tmp/cfg"));
  assert.equal(claudeJsonPath(undefined, env), join(resolve("/tmp/cfg"), ".claude.json"));
  // A caller that names its own home (a test, a scratch folder) gets that home's .claude, whatever the environment says.
  assert.equal(claudeDir("/tmp/other", env), join("/tmp/other", ".claude"));
  assert.equal(claudeJsonPath("/tmp/other", env), join("/tmp/other", ".claude.json"));
  assert.equal(claudeDir(undefined, { HOME: "/tmp/h" }), join("/tmp/h", ".claude"));
  assert.equal(claudeJsonPath(undefined, { HOME: "/tmp/h" }), join("/tmp/h", ".claude.json"));
});

test("no source file reaches for os.homedir() or the account's home outside the helper", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = join(process.cwd(), "src");
  const bad: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && p !== join(root, "util", "home.ts")) {
        const text = readFileSync(p, "utf8");
        // The generated hook shim and pre-bash's no-import fast path name os.homedir() after HOME; host-facts compares against the account's
        // own home on purpose, to tell a test home from the person's (read-only).
        if (/\bhomedir\(\)|userInfo\(\)\.homedir/.test(text) && !/shim-template|pre-bash\.ts|host-facts\.ts/.test(p)) bad.push(p.slice(root.length + 1));
      }
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});
