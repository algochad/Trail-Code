/**
 * A hook is not an installer. Every `trail hook <event>` runs against a temp HOME and CLAUDE_CONFIG_DIR, in a repo
 * wired the old way (stale or no wiring stamp, the case an upkeep refresh used to rewrite) and in a repo set up by
 * trail init, and nothing may be created or changed outside the repo's .trail/ and the temp home's .trail/
 * (graft-wired repos keep their cache in graft/.cache, so that counts for them). Settings, helper scripts,
 * status lines, skills and MCP entries are only ever written by `trail init` or another explicit command.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { main } from "../src/claude/hooks.js";
import { runInit } from "../src/claude/init.js";
import { writeStamp } from "../src/upkeep.js";

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `hooks-nowrite-${tag}-`));
  roots.push(d);
  return d;
}

/** Every file under `dir` (but not .git) as path -> content hash and modification time, so a rewrite with the same bytes shows too. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (lstatSync(p).isFile()) out.set(relative(dir, p), `${createHash("sha1").update(readFileSync(p)).digest("hex")}@${lstatSync(p).mtimeMs}`);
      else out.set(relative(dir, p), "link");
    }
  };
  walk(dir);
  return out;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

function repoWith(home: string, tag: string, kind: "graft-stale" | "graft-unstamped" | "trail" | "trail-plugin"): string {
  const repo = join(tmp(tag), "app");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: repo });
  if (kind.startsWith("graft")) {
    runInit(repo, { build: false, home, brand: "graft" });
    if (kind === "graft-stale") writeStamp(repo, "0.0.1", ["claude"]);
    else rmSync(join(repo, "graft", ".cache", "wiring-stamp.json"), { force: true });
  } else if (kind === "trail") runInit(repo, { build: false, home, brand: "trail" });
  else runInit(repo, { build: false, home, brand: "trail", hooks: false, statusline: false, global: true });
  return repo;
}

const EVENTS = ["session-start", "session-end", "prompt", "stop", "pre-edit", "post-edit", "post-edit-sync", "tool-savings", "post-bash-fail", "codex-post-bash", "pre-bash", "cursor-post-tool", "cursor-mcp", "cursor-session-end", "no-such-event"];

function payloads(repo: string): string[] {
  const file = join(repo, "src", "a.ts");
  return [
    "{}",
    JSON.stringify({
      cwd: repo, session_id: "s1", transcript_path: join(repo, "nope.jsonl"), prompt: "why does alpha return 1 here, and who calls it",
      tool_name: "Bash", tool_input: { command: "git commit -m x", file_path: file }, tool_response: { stdout: "ok", exit_code: 0 },
      stop_hook_active: false, hook_event_name: "Stop",
    }),
  ];
}

async function runAll(repo: string, home: string): Promise<void> {
  const saved = { ...process.env };
  const write = process.stdout.write;
  try {
    Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_PROJECT_DIR: repo, DO_NOT_TRACK: "1", TRAIL_NO_FETCH: "1" });
    for (const k of ["TRAIL_HOME", "CODEX_HOME", "TRAIL_NO_HOOKS"]) delete process.env[k];
    // Strings are the hook's output; the runner's own reports (bytes) pass through.
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === "string" ? true : (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest))) as typeof process.stdout.write;
    for (const input of payloads(repo)) {
      for (const event of EVENTS) {
        process.env.GRAFT_TEST_STDIN = input;
        await main(event);
      }
    }
  } finally {
    process.stdout.write = write;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

for (const kind of ["graft-stale", "graft-unstamped", "trail", "trail-plugin"] as const) {
  test(`no hook event writes settings, helpers, skills or MCP entries anywhere (${kind} repo, temp HOME and CLAUDE_CONFIG_DIR)`, async () => {
    const home = tmp(`home-${kind}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    const repo = repoWith(home, kind, kind);
    await new Promise((ok) => setTimeout(ok, 30));
    const homeBefore = snapshot(home);
    const repoBefore = snapshot(repo);
    await runAll(repo, home);
    const inHome = changed(homeBefore, snapshot(home)).filter((n) => !n.startsWith(".trail/"));
    assert.deepEqual(inHome, [], "outside the temp home's .trail/");
    const allowed = (n: string) => n.startsWith(".trail/") || (kind.startsWith("graft") && n.startsWith("graft/.cache/"));
    assert.deepEqual(changed(repoBefore, snapshot(repo)).filter((n) => !allowed(n)), [], "outside the repo's .trail/");
  });
}
