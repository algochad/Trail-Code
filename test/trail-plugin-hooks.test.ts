/**
 * A Claude Code plugin owns hook registration: `trail hooks print` gives it the
 * `hooks` object for its hooks/hooks.json, `trail hook <event>` is what those
 * hooks run (and always exits 0), and `trail init --no-hooks --no-statusline`
 * sets the repo up without writing any Claude Code settings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeEnv, tmpRepo } from "./helpers.js";
import { mergeTrailLocal, pluginHooks, trailHookCmd } from "../src/claude/settings-merge.js";

function trail(args: string[], home: string, opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    input: opts.input ?? "",
    env: { ...process.env, ...homeEnv(home), TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1", CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined, TRAIL_INVOKED_AS: undefined, ...opts.env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const EVENTS = ["PostToolUse", "UserPromptSubmit", "PreToolUse", "PostToolUseFailure", "SessionStart", "Stop"];

test("trail hooks print is the hooks object of a plugin's hooks.json: same events, matchers and timeouts init registers", () => {
  const r = trail(["hooks", "print"], tmpRepo("hooks-print-home"));
  assert.equal(r.status, 0, r.err);
  const hooks = JSON.parse(r.out);
  assert.deepEqual(Object.keys(hooks).sort(), [...EVENTS].sort());
  // Identical to what init registers, command aside: the same blocks with `trail hook <event>` for the shim.
  const registered = mergeTrailLocal({}, { hooks: true, statusline: false }).merged.hooks;
  const sameButCommand = (blocks: any[]) => JSON.stringify(blocks, (k, v) => (k === "command" ? "<cmd>" : v));
  for (const event of EVENTS.filter((e) => e !== "SessionStart")) assert.equal(sameButCommand(hooks[event]), sameButCommand(registered[event]), event);
  assert.equal(sameButCommand(hooks.SessionStart), sameButCommand([{ hooks: [{ type: "command", command: trailHookCmd("session-start"), timeout: 10 }] }]));
  assert.deepEqual(hooks.PostToolUse.map((b: any) => b.hooks[0].timeout), [10, 8]);
});

test("every printed command is `trail hook <event>` that fails open, with no shim path in it", () => {
  const hooks = pluginHooks();
  const commands = Object.values(hooks).flatMap((blocks: any[]) => blocks.flatMap((b) => b.hooks.map((h: any) => h.command)));
  assert.ok(commands.length >= 8);
  for (const c of commands) assert.match(c, /^trail hook [a-z-]+ \|\| exit 0$/, c);
  assert.ok(!JSON.stringify(hooks).includes(".trail/hook.cjs") && !JSON.stringify(hooks).includes("CLAUDE_PROJECT_DIR"));
});

test("trail hook <event> exits 0 and says nothing on bad input, an unknown event or a missing project folder", () => {
  const home = tmpRepo("hook-fail-open-home");
  for (const event of ["session-start", "pre-bash", "stop", "no-such-event"]) {
    for (const input of ["", "not json"]) {
      const r = trail(["hook", event], home, { input, env: { CLAUDE_PROJECT_DIR: "/does/not/exist" } });
      assert.equal(r.status, 0, `${event} ${JSON.stringify(input)}: ${r.err}`);
    }
  }
});

test("trail hook with no event exits 0 too", () => {
  assert.equal(trail(["hook"], tmpRepo("hook-none-home")).status, 0);
});

/* ---- init without Claude Code settings ---- */

function gitRepoWithCode(tag: string): string {
  const d = tmpRepo(tag);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  return d;
}

test("init --no-hooks --no-statusline sets up .trail/, the graph and the skill, and writes no Claude Code settings", () => {
  const home = tmpRepo("plugin-init-home");
  const d = gitRepoWithCode("plugin-init");
  const ownSettings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./mine.sh" }] }] }, permissions: { allow: ["Bash(make:*)"] } }, null, 2) + "\n";
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, ".claude", "settings.json"), ownSettings);
  const r = trail(["init", d, "--agents", "claude", "--no-hooks", "--no-statusline"], home);
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(join(d, ".claude", "settings.json"), "utf8"), ownSettings, "the repo's settings.json is untouched");
  assert.equal(existsSync(join(d, ".claude", "settings.local.json")), false, "no personal settings either");
  assert.equal(existsSync(join(d, ".trail", "hook.cjs")), false, "no hook shim: the plugin runs `trail hook`");
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "nothing in ~/.claude/settings.json");
  assert.equal(existsSync(join(home, ".claude", "helpers")), false);
  assert.ok(existsSync(join(d, ".trail", "learnings")), ".trail/ is set up");
  assert.ok(existsSync(join(d, ".trail", "cache")), "the code map is built");
  assert.ok(existsSync(join(home, ".claude", "skills", "trail", "SKILL.md")), "the skill file is written");
});

test("a session refresh after init --no-hooks does not bring the hooks back", () => {
  const home = tmpRepo("plugin-refresh-home");
  const d = gitRepoWithCode("plugin-refresh");
  assert.equal(trail(["init", d, "--agents", "claude", "--no-hooks", "--no-statusline", "--no-build"], home).status, 0);
  const stamp = JSON.parse(readFileSync(join(d, ".trail", "cache", ".cache", "wiring-stamp.json"), "utf8"));
  assert.equal(stamp.opts.hooks, false);
  assert.equal(stamp.opts.statusline, false);
  // An upgrade: the stamp names an older version, the next session start rewrites the wiring with the flags it kept.
  writeFileSync(join(d, ".trail", "cache", ".cache", "wiring-stamp.json"), JSON.stringify({ ...stamp, version: "0.0.1" }));
  const out = trail(["hook", "session-start"], home, { cwd: d, input: JSON.stringify({ cwd: d, session_id: "s1" }), env: { CLAUDE_PROJECT_DIR: d } });
  assert.equal(out.status, 0, out.err);
  assert.equal(existsSync(join(d, ".claude", "settings.json")), false, "still no settings.json");
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
});

test("init --no-hooks alone still writes the status line, and no hooks", () => {
  const home = tmpRepo("plugin-sl-home");
  const d = gitRepoWithCode("plugin-sl");
  const r = trail(["init", d, "--agents", "claude", "--no-hooks", "--no-build"], home);
  assert.equal(r.status, 0, r.err);
  assert.equal(existsSync(join(d, ".claude", "settings.json")), false);
  const local = JSON.parse(readFileSync(join(d, ".claude", "settings.local.json"), "utf8"));
  assert.match(local.statusLine.command, /statusline\.cjs/);
  assert.equal(local.hooks, undefined);
});
