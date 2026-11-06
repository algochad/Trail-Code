/**
 * A hook is started for every shell command and every edit, so its entry must not load the CLI, the model SDKs or the
 * tree-sitter graph code unless the event needs them. This runs `trail hook <event>` with a loader that lists every
 * file the process loads, and checks the heavy ones are not among them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv } from "./helpers.js";

function loaded(event: string, payload: object): string[] {
  const root = mkdtempSync(join(tmpdir(), "hook-light-"));
  const record = join(root, "loads.txt");
  const home = join(root, "home");
  try {
    const r = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--import", new URL("./record-loads.mjs", import.meta.url).href, join(process.cwd(), "src", "bin", "trail.ts"), "hook", event],
      {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({ cwd: root, session_id: "s1", ...payload }),
        env: { ...process.env, ...homeEnv(home), TRAIL_HOME: join(home, ".trail"), RECORD_LOADS_FILE: record, CLAUDE_PROJECT_DIR: root, DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_NO_FETCH: "1" },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(record, "utf8").split("\n").filter(Boolean).map((u) => u.replace(/^file:\/\//, ""));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HEAVY_FOR_EVERY_EVENT = [/\/src\/cli\.ts$/, /\/src\/engine\.ts$/, /\/node_modules\/commander\//, /\/node_modules\/openai\//, /\/node_modules\/@anthropic-ai\//, /\/src\/ai\/llm\//, /\/src\/ai\/providers\.ts$/, /\/src\/cli-wiring\.ts$/];

const EVENTS: Array<[string, object]> = [
  ["pre-bash", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }],
  ["pre-edit", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/nowhere/a.ts" } }],
  ["post-edit", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/nowhere/a.ts" } }],
  ["tool-savings", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }],
  ["prompt", { hook_event_name: "UserPromptSubmit", prompt: "hi" }],
  ["session-start", { hook_event_name: "SessionStart", source: "startup" }],
  ["stop", { hook_event_name: "Stop" }],
];

for (const [event, payload] of EVENTS) {
  test(`trail hook ${event} loads neither the CLI, the model SDKs nor the engine`, () => {
    const files = loaded(event, payload);
    assert.ok(files.some((f) => /\/src\/bin\/trail\.ts$/.test(f)), "the entry itself was recorded");
    const heavy = files.filter((f) => HEAVY_FOR_EVERY_EVENT.some((re) => re.test(f)));
    assert.deepEqual(heavy, []);
  });
}

test("trail hook pre-bash loads almost nothing: no graph, notes, skills or init code", () => {
  const files = loaded("pre-bash", EVENTS[0]![1]);
  const mine = files.filter((f) => f.includes("/src/") && !/\/src\/(bin\/|node-version|util\/(home|compile-cache)|brand\.ts|claude\/(hook-entry|pre-bash))/.test(f));
  assert.deepEqual(mine, []);
});
