/**
 * A user's git config must not change what trail reads from git. `diff.mnemonicPrefix`
 * turns `a/` and `b/` into `i/` and `w/`, `diff.colorMoved` and `color.ui` add escape
 * codes, `core.quotePath` quotes non-ASCII paths. Injected here through GIT_CONFIG_*
 * (set after the scratch repo is built, so only trail's own git calls see it).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles } from "../src/blast/diff.js";
import { branchDiff } from "../src/cloud/diff.js";
import { parseTrailDiff } from "../src/check/local-check.js";
import { tmpRepo } from "./helpers.js";

const COMMON: Record<string, string> = {
  "diff.colorMoved": "plain",
  "diff.algorithm": "histogram",
  "color.ui": "always",
  "color.diff": "always",
  "core.quotePath": "true",
};
// Each prefix setting changes `a/`/`b/` differently, so each gets its own run.
const VARIANTS: Record<string, Record<string, string>> = {
  mnemonicPrefix: { ...COMMON, "diff.mnemonicPrefix": "true" },
  noprefix: { ...COMMON, "diff.noprefix": "true" },
};

function git(d: string, args: string[]) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

const saved: Record<string, string | undefined> = {};
function injectHostileConfig(HOSTILE: Record<string, string>) {
  const keys = Object.keys(HOSTILE);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(keys.length) };
  keys.forEach((k, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = HOSTILE[k]!;
  });
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
}
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function repo(): string {
  const d = tmpRepo("hostile-git");
  git(d, ["init", "-q", "-b", "main"]);
  writeFileSync(join(d, "café.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  writeFileSync(join(d, "café.ts"), "export const a = 1;\nexport const b = 3;\n");
  return d;
}

for (const [name, cfg] of Object.entries(VARIANTS)) {
test(`blast reads the changed file and hunk through hostile git config (${name})`, () => {
  const d = repo();
  injectHostileConfig(cfg);
  const r = changedFiles(d);
  assert.deepEqual(r?.files.map((f) => f.path), ["café.ts"]);
  assert.deepEqual(r?.files[0]?.ranges, [{ start: 2, end: 2 }]);
});

test(`trail check's branch diff is plain unified text through hostile git config (${name})`, () => {
  const d = repo();
  injectHostileConfig(cfg);
  const r = branchDiff(d, "HEAD");
  assert.deepEqual(r?.files, ["café.ts"]);
  assert.doesNotMatch(r!.diff, /\u001b/);
  assert.match(r!.diff, /^\+\+\+ b\/café\.ts$/m);
  assert.deepEqual(parseTrailDiff(r!.diff).map((f) => f.path), ["café.ts"]);
});
}
