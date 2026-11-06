/**
 * The teammate-branch refresh reads the refs already on this machine. It runs `git fetch` and `gh pr list` only when
 * asked to: TRAIL_FETCH=1. Branches that are already fetched keep working the same either way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { refreshBranches } from "../src/notes/branches.js";

process.env.DO_NOT_TRACK = "1";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "fetch-opt-in-home-"));
delete process.env.TRAIL_NO_FETCH;
delete process.env.TRAIL_FETCH;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A bare remote, my clone, and a teammate's clone that pushes a branch after I cloned. */
function setup(): { me: string; push: (branch: string) => void; gh: string } {
  const root = mkdtempSync(join(tmpdir(), "fetch-opt-in-"));
  const bare = join(root, "r.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  mkdirSync(join(seed, "src"));
  writeFileSync(join(seed, "src", "a.ts"), "export const a = 1;\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=S", "-c", "user.email=s@x", "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  const clone = (who: string) => {
    const d = join(root, who);
    git(root, "clone", "-q", bare, d);
    git(d, "config", "user.name", who);
    git(d, "config", "user.email", `${who}@x`);
    git(d, "remote", "set-head", "origin", "main");
    return d;
  };
  const me = clone("me");
  const them = clone("them");
  const push = (branch: string) => {
    git(them, "checkout", "-q", "-b", branch);
    writeFileSync(join(them, "src", "a.ts"), "export const a = 2;\n");
    git(them, "commit", "-qam", "change a");
    git(them, "push", "-q", "origin", branch);
  };
  // A `gh` that records being asked.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(root, "gh-calls")}"\necho '[]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { me, push, gh: bin };
}

const refs = (c: { branches: Array<{ ref: string }> }) => c.branches.map((b) => b.ref);

test("by default the refresh fetches nothing and asks gh nothing, and reads what is already here", { skip: process.platform === "win32" }, () => {
  const { me, push, gh } = setup();
  push("kumar/new");
  const saved = process.env.PATH;
  process.env.PATH = `${gh}${delimiter}${saved}`;
  try {
    const c = refreshBranches(me, { prs: true });
    assert.deepEqual(refs(c), [], "the teammate's branch was never fetched");
    assert.equal(existsSync(join(gh, "..", "gh-calls")), false, "gh was not asked");
    git(me, "fetch", "-q", "origin");
    assert.deepEqual(refs(refreshBranches(me)), ["origin/kumar/new"], "once the person fetches, it is read");
  } finally {
    process.env.PATH = saved;
  }
});

test("TRAIL_FETCH=1 fetches", { skip: process.platform === "win32" }, () => {
  const { me, push, gh } = setup();
  push("kumar/new");
  git(me, "remote", "set-url", "origin", git(me, "remote", "get-url", "origin").trim());
  process.env.TRAIL_FETCH = "1";
  const saved = process.env.PATH;
  process.env.PATH = `${gh}${delimiter}${saved}`;
  try {
    assert.deepEqual(refs(refreshBranches(me)), ["origin/kumar/new"]);
  } finally {
    delete process.env.TRAIL_FETCH;
    process.env.PATH = saved;
  }
});

test("TRAIL_NO_FETCH=1 wins over TRAIL_FETCH=1", { skip: process.platform === "win32" }, () => {
  const { me, push } = setup();
  push("kumar/new");
  process.env.TRAIL_FETCH = "1";
  process.env.TRAIL_NO_FETCH = "1";
  try {
    assert.deepEqual(refs(refreshBranches(me)), []);
  } finally {
    delete process.env.TRAIL_FETCH;
    delete process.env.TRAIL_NO_FETCH;
  }
});
