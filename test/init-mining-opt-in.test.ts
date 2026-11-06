/**
 * `trail init` reads nothing from history unless asked: past Claude Code
 * transcripts need --mine-sessions, a repo's merged PR reviews (through gh)
 * need --mine-prs. Default off; init says in one line how to turn them on.
 * The model (`claude`) and `gh` are stand-ins on PATH that count their calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beginLookBack } from "../src/init/run.js";
import type { PsRow } from "../src/skills/person.js";
import { day, done, releaseJob, Tx, world, type World } from "./init-mine-fixtures.js";
import { jsLit } from "./escape.js";

const posixOnly = { skip: process.platform === "win32" ? "shebang stand-ins" : false };

const ME = 4242;
const ps = (): PsRow[] => [
  { pid: 1, ppid: 0, comm: "/sbin/launchd", args: "/sbin/launchd" },
  { pid: 10, ppid: 1, comm: "/bin/zsh", args: "-zsh" },
  { pid: ME, ppid: 10, comm: "node", args: "node trail init" },
];
/** The person at their own terminal: the only run that may start `claude` and read PRs. */
const atTerminal = { stdinTTY: true, stdoutTTY: true, ps, pid: ME };

/** A past session for the repo, so there is something to look back at. */
function history(w: World): void {
  const a = new Tx(w.repo);
  releaseJob(a, 1, "1.0.1", { failedFirst: true });
  a.typed(day(1, 12), "always run the lint script before you push");
  a.write(w.home, "s-a");
}

/** `claude` and `gh` stand-ins that count what they are asked. */
function standIns(): { bin: string; claude: () => number; gh: () => number } {
  const bin = mkdtempSync(join(tmpdir(), "graft-mine-bin-"));
  const answer = JSON.stringify({ is_error: false, structured_output: { findings: [] } });
  const counter = (name: string) => join(bin, `${name}-calls`);
  writeFileSync(join(bin, "claude"), [
    "#!/usr/bin/env node",
    `const fs = require("fs");`,
    `if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }`,
    `fs.appendFileSync(${jsLit(counter("claude"))}, "-p\\n");`,
    `process.stdin.resume(); process.stdin.on("end", () => console.log(${jsLit(answer)}));`,
  ].join("\n"));
  writeFileSync(join(bin, "gh"), [
    "#!/usr/bin/env node",
    `require("fs").appendFileSync(${jsLit(counter("gh"))}, process.argv.slice(2).join(" ") + "\\n");`,
    `console.log("{}");`,
  ].join("\n"));
  for (const n of ["claude", "gh"]) chmodSync(join(bin, n), 0o755);
  const count = (name: string) => (existsSync(counter(name)) ? readFileSync(counter(name), "utf8").split("\n").filter(Boolean).length : 0);
  return { bin, claude: () => count("claude"), gh: () => count("gh") };
}

async function inWorld<T>(tag: string, fn: (w: World, env: NodeJS.ProcessEnv, s: ReturnType<typeof standIns>) => Promise<T>): Promise<T> {
  const w = world(`mine-${tag}`);
  history(w);
  const s = standIns();
  const saved = { trail: process.env.TRAIL_HOME, path: process.env.PATH };
  process.env.TRAIL_HOME = w.trail;
  process.env.PATH = `${s.bin}${delimiter}${saved.path}`;
  try {
    return await fn(w, { HOME: w.home, TRAIL_HOME: w.trail, PATH: `${s.bin}${delimiter}${saved.path}`, DO_NOT_TRACK: "1" }, s);
  } finally {
    for (const [k, v] of [["TRAIL_HOME", saved.trail], ["PATH", saved.path]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    done(w);
    rmSync(s.bin, { recursive: true, force: true });
  }
}

/** Let a read that was started in the background reach its first `gh` call. */
const settle = () => new Promise((ok) => setTimeout(ok, 500));

test("by default init reads no past sessions and no PRs, and starts no claude or gh", posixOnly, async () => {
  await inWorld("default", async (w, env, s) => {
    const { reads, lines } = beginLookBack(w.repo, { env, deps: atTerminal });
    await settle();
    assert.equal(reads.lb, null, "no look-back at past transcripts");
    assert.equal(reads.sessions, null, "no session read");
    assert.equal(reads.reviews, null, "no PR read");
    assert.deepEqual(reads.memory, [], "Claude's own notes are not read either");
    assert.deepEqual(lines, []);
    assert.equal(s.claude(), 0);
    assert.equal(s.gh(), 0);
  });
});

test("--mine-sessions reads past sessions, and still no PRs", posixOnly, async () => {
  await inWorld("sessions", async (w, env, s) => {
    const { reads } = beginLookBack(w.repo, { env, deps: atTerminal, mineSessions: true });
    await settle();
    assert.notEqual(reads.lb, null);
    assert.notEqual(reads.sessions, null);
    assert.equal(reads.reviews, null);
    assert.equal(s.gh(), 0, "gh is never started without --mine-prs");
  });
});

test("--mine-prs reads PR reviews through gh, and still no past sessions", posixOnly, async () => {
  await inWorld("prs", async (w, env, s) => {
    const { reads } = beginLookBack(w.repo, { env, deps: atTerminal, minePrs: true });
    await settle();
    assert.notEqual(reads.reviews, null);
    assert.ok(s.gh() > 0, "gh was asked");
    assert.equal(reads.lb, null);
    assert.equal(reads.sessions, null);
    assert.deepEqual(reads.memory, []);
  });
});

test("both flags together turn both reads on", posixOnly, async () => {
  await inWorld("both", async (w, env) => {
    const { reads } = beginLookBack(w.repo, { env, deps: atTerminal, mineSessions: true, minePrs: true });
    await settle();
    assert.notEqual(reads.lb, null);
    assert.notEqual(reads.sessions, null);
    assert.notEqual(reads.reviews, null);
  });
});

// --- the command: flags and the one line ---

function init(w: World, extra: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", w.repo, "--agents", "claude", "--no-build", "--no-global", ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME: w.home, USERPROFILE: w.home, TRAIL_HOME: w.trail, DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_NO_LOOK_BACK: undefined, TRAIL_NO_FETCH: "1" },
  });
  return { status: r.status, err: r.stderr, out: r.stdout };
}

const OFF_LINE = /not reading your past Claude Code sessions or this repo's pull requests/;

test("trail init says in one line how to turn the reads on, and reads nothing", posixOnly, async () => {
  await inWorld("cli-default", async (w) => {
    const r = init(w, []);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, OFF_LINE);
    assert.match(r.err, /--mine-sessions/);
    assert.match(r.err, /--mine-prs/);
    assert.equal(r.err.split("\n").filter((l) => OFF_LINE.test(l)).length, 1, "one line");
    assert.doesNotMatch(r.err, /looking back at your past Claude Code sessions/);
  });
});

test("trail init --mine-sessions looks back at past sessions and only mentions --mine-prs", posixOnly, async () => {
  await inWorld("cli-sessions", async (w) => {
    const r = init(w, ["--mine-sessions"]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /looking back at your past Claude Code sessions/);
    assert.doesNotMatch(r.err, OFF_LINE);
    assert.match(r.err, /--mine-prs/);
    assert.doesNotMatch(r.err, /--mine-sessions/);
  });
});

test("trail init with both flags says nothing about turning them on", posixOnly, async () => {
  await inWorld("cli-both", async (w) => {
    const r = init(w, ["--mine-sessions", "--mine-prs"]);
    assert.equal(r.status, 0, r.err);
    assert.doesNotMatch(r.err, /--mine-/);
    assert.match(r.err, /looking back at your past Claude Code sessions/);
  });
});
