/**
 * A Claude Code plugin owns hook registration: `trail hooks print` gives it the
 * `hooks` object for its hooks/hooks.json, `trail hook <event>` is what those
 * hooks run (and always exits 0), and `trail init --no-hooks --no-statusline`
 * sets the repo up without writing any Claude Code settings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Every file under `dir`, relative, with forward slashes. */
function filesUnder(dir: string): string[] {
  return (existsSync(dir) ? (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]) : [])
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/"))
    .sort();
}

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

test("hooks run after init --no-hooks, even with an old wiring stamp, write nothing of their own and never bring the hooks back", () => {
  const home = tmpRepo("plugin-refresh-home");
  const d = gitRepoWithCode("plugin-refresh");
  assert.equal(trail(["init", d, "--agents", "claude", "--no-hooks", "--no-statusline", "--no-build"], home).status, 0);
  const stampPath = join(d, ".trail", "cache", ".cache", "wiring-stamp.json");
  const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  assert.equal(stamp.opts.hooks, false);
  assert.equal(stamp.opts.statusline, false);
  writeFileSync(stampPath, JSON.stringify({ ...stamp, version: "0.0.1" }));
  for (const event of ["session-start", "prompt", "stop"]) {
    const out = trail(["hook", event], home, { cwd: d, input: JSON.stringify({ cwd: d, session_id: "s1", prompt: "hello there, how does alpha work" }), env: { CLAUDE_PROJECT_DIR: d } });
    assert.equal(out.status, 0, out.err);
  }
  assert.equal(existsSync(join(d, ".claude", "settings.json")), false, "still no settings.json");
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
});

test("init --plugin writes nothing under ~/.claude, no skill, no hooks, no status line, and says in .trail/ that a plugin owns the hooks", () => {
  const home = tmpRepo("plugin-flag-home");
  const d = gitRepoWithCode("plugin-flag");
  const r = trail(["init", d, "--agents", "claude", "--plugin"], home, { env: { CLAUDE_CONFIG_DIR: join(home, ".claude") } });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(filesUnder(home).filter((f) => !f.startsWith(".trail/")), [], "outside the temp home's .trail/");
  assert.equal(existsSync(join(home, ".claude")), false);
  assert.equal(existsSync(join(home, ".claude.json")), false);
  assert.equal(existsSync(join(d, ".claude")), false, "nothing in the repo's .claude either");
  assert.equal(existsSync(join(d, ".mcp.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(d, ".trail", "plugin-managed.json"), "utf8")), { hooks: "plugin" });
  assert.ok(existsSync(join(d, ".trail", "cache")), "the code map is built");
});

test("a repo that says its hooks are plugin-managed is a trail repo: hooks keep their state in .trail/, never graft/", () => {
  const home = tmpRepo("plugin-brand-home");
  const d = gitRepoWithCode("plugin-brand");
  assert.equal(trail(["init", d, "--agents", "claude", "--plugin", "--no-build"], home).status, 0);
  const out = trail(["hook", "stop"], home, { cwd: d, input: JSON.stringify({ cwd: d, session_id: "s9" }), env: { CLAUDE_PROJECT_DIR: d } });
  assert.equal(out.status, 0, out.err);
  assert.equal(existsSync(join(d, "graft")), false);
});

test("trail skill export --out writes the SKILL.md init would write, and touches nothing else", () => {
  const home = tmpRepo("skill-export-home");
  const out = join(tmpRepo("skill-export-out"), "plugin", "skills", "trail");
  const r = trail(["skill", "export", "--out", out], home, { env: { CLAUDE_CONFIG_DIR: join(home, ".claude") } });
  assert.equal(r.status, 0, r.err);
  assert.equal(filesUnder(home).filter((f) => !f.startsWith(".trail/")).length, 0);
  // The same bytes init puts in ~/.claude/skills/trail/SKILL.md.
  const other = tmpRepo("skill-export-home2");
  assert.equal(trail(["init", gitRepoWithCode("skill-export-repo"), "--agents", "claude", "--no-build"], other).status, 0);
  assert.equal(readFileSync(join(out, "SKILL.md"), "utf8"), readFileSync(join(other, ".claude", "skills", "trail", "SKILL.md"), "utf8"));
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
