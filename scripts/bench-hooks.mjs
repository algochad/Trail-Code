#!/usr/bin/env node
/**
 * How long each `trail hook <event>` takes, the way a plugin runs it: a fresh process per call, the payload on stdin.
 *
 *   npm run build && node scripts/bench-hooks.mjs [--runs 10] [--bin dist/bin/trail.js]
 *
 * Every event runs N times with `{}` and N times with a realistic payload, against a throwaway repo set up by
 * `trail init --plugin` and a throwaway HOME (the real one is never touched). Prints median and p95 in ms, next to
 * a bare `node -e 0`, and exits 1 when a median is over its target:
 *   pre-bash, pre-edit, post-edit, tool-savings: 150 ms    prompt, session-start, stop: 300 ms
 * Run it on a quiet machine; the numbers are wall-clock.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const runs = Number(arg("--runs", "10"));
const bin = resolve(arg("--bin", join(root, "dist", "bin", "trail.js")));
if (!existsSync(bin)) {
  console.error(`✗ ${bin} not found: run npm run build first`);
  process.exit(2);
}

const TARGETS = { "pre-bash": 150, "pre-edit": 150, "post-edit": 150, "tool-savings": 150, prompt: 300, "session-start": 300, stop: 300 };

const work = mkdtempSync(join(tmpdir(), "bench-hooks-"));
const home = join(work, "home");
const repo = join(work, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(repo, "src", "a.ts"), "export function alpha(): number {\n  return beta();\n}\nexport function beta(): number {\n  return 1;\n}\n");

const clean = { ...process.env };
for (const k of Object.keys(clean)) if (k.startsWith("CLAUDE") || k === "TRAIL_HOME" || k === "CODEX_HOME") delete clean[k];
const env = {
  ...clean, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_PROJECT_DIR: repo,
  DO_NOT_TRACK: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (...a) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "init");
const init = spawnSync(process.execPath, [bin, "init", repo, "--agents", "claude", "--plugin"], { cwd: repo, env, encoding: "utf8" });
if (init.status !== 0) {
  console.error(init.stderr);
  process.exit(2);
}

const file = join(repo, "src", "a.ts");
const base = { cwd: repo, session_id: "bench-1", transcript_path: join(work, "none.jsonl") };
const PAYLOADS = {
  "pre-bash": { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test -- --watch=false" } },
  "pre-edit": { ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: "return 1;", new_string: "return 2;" } },
  "post-edit": { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: "return 1;", new_string: "return 2;" }, tool_response: { filePath: file, success: true } },
  "tool-savings": { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls src" }, tool_response: { stdout: "a.ts\n", stderr: "", exit_code: 0 } },
  prompt: { ...base, hook_event_name: "UserPromptSubmit", prompt: "where is alpha defined and who calls beta" },
  "session-start": { ...base, hook_event_name: "SessionStart", source: "startup" },
  stop: { ...base, hook_event_name: "Stop", stop_hook_active: false },
};

function time(args, input) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { cwd: repo, env, input, encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return ms;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] };
};
const fmt = (n) => String(Math.round(n)).padStart(5);

const bare = stats(Array.from({ length: runs }, () => time(["-e", "0"], "")));
console.log(`node -e 0 (floor)                      median ${fmt(bare.median)} ms   p95 ${fmt(bare.p95)} ms`);
console.log(`runs per row: ${runs}   bin: ${bin}\n`);
console.log("event            payload     median   p95    target");
let failed = false;
for (const event of Object.keys(TARGETS)) {
  for (const [label, input] of [["{}", "{}"], ["realistic", JSON.stringify(PAYLOADS[event])]]) {
    time([bin, "hook", event], input); // warm the disk cache; not counted
    const { median, p95 } = stats(Array.from({ length: runs }, () => time([bin, "hook", event], input)));
    const over = median > TARGETS[event];
    if (over) failed = true;
    console.log(`${event.padEnd(16)} ${label.padEnd(10)} ${fmt(median)}  ${fmt(p95)}   < ${TARGETS[event]} ${over ? "OVER" : "ok"}`);
  }
}
rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
