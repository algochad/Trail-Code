#!/usr/bin/env node
/**
 * The `trail` CLI, also run as `graft`, its old name. Commands: build, ask,
 * check, viz, mcp, callers, skeleton, grep, map, init. Git is the sync: commit
 * graft/ and a clone has the graph. A workspace parent (≥2 git children)
 * federates query commands across children.
 *
 * Both names run this file. Under `graft` every command keeps its old name and
 * meaning; under `trail` the layout changes (see `TRAIL` below and brand.ts).
 */
import { spawnSync } from "node:child_process";
import "dotenv/config";
import { Command } from "commander";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Graft } from "./engine.js";
import { resolveConfig, type EngineConfig } from "./ai/providers.js";
import type { ProviderKind } from "./ai/llm/factory.js";
import { formatCheckReport } from "./context/check.js";
import { formatGraphCheckReport } from "./graph/check.js";
import { pluginHooks, statuslineWanted } from "./claude/settings-merge.js";
import { skillTemplate } from "./claude/skill-template.js";
import { codexStatusLines, codexTrustLine } from "./hosts/codex-trust.js";
import { hostIds } from "./hosts/registry.js";
import type { Retraction } from "./hosts/retract.js";
import type { planInit as PlanInit } from "./hosts/plan.js";
import { agentList, autoSelection, autoSummary } from "./hosts/auto.js";
import { checkoutRoot, ensureRepoHome, keepsNotes, noteCount, rememberRepo, repoName, repoPlace, shownPath } from "./notes/home.js";
import { brand, cmd, graftNotice, strandedRepoNotice, tag } from "./brand.js";
import { branchDiff } from "./check/branch-diff.js";
import { committedAtBase, learningsAtBase, teammateEdits, withBaseLearnings } from "./check/learning-edits.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "./graph/refresh.js";
import { isWorkspaceBuildRoot, readWorkspace } from "./graph/workspace.js";
import { NOT_GIT_LINE, homeFolderRefusal, isGitWorkTree } from "./init-guard.js";
import { hasGraftIndex, nearestGraftRoot } from "./graph/root.js";
import { unsupportedExtensions, supportedExtensions } from "./graph/source-files.js";
import { discoverWorkspaceChildren } from "./graph/scopes.js";
import {
  runWorkspaceAsk,
  runWorkspaceBuild,
  runWorkspaceCallers,
  runWorkspaceCheck,
  runWorkspaceGrep,
  runWorkspaceMap,
} from "./graph/workspace-cli.js";
import { formatInitEpilogue } from "./cli-epilogue.js";
import { readCurrentVersion, readPackageName } from "./cli-meta.js";
import { nativeFallbackNotice } from "./graph/native.js";
import { patchBuildConfig, type BuildConfig } from "./util/state.js";
import { normalizePathPrefix } from "./util/paths.js";
import { latestSession, formatSessionStats, sessionInputRate } from "./claude/session-metrics.js";
import { listSessionIds, readSession, sessionDir } from "./claude/state.js";
import { costLabel, listNotes, noteName, notePlace, noteTargets, readingTokens, commitLines, PERSONAL_SAVED_LINE, PR_SPEEDUP, SECTIONS, tokensWorthSaying, sectionLead, shortDate, tokensLabel, writeNote, type Note, mentionedFiles } from "./notes/notes.js";
import { aboutTerms, currentSessionCost } from "./notes/session-cost.js";
import { unmarkedWords } from "./notes/flatten.js";
import { currentBranch, noteAuthor, teammatesOn } from "./notes/git-facts.js";
import { gateNote, namesRepoSymbol, symbolCandidates, trackedFiles } from "./notes/note-gate.js";
import type { CheckResult } from "./check/types.js";
import { checkLocally } from "./check/local-check.js";
import { findLearning, liveLearnings } from "./notes/learning-fields.js";
import { savedIdLine } from "./notes/replace.js";
import { ALWAYS_FOLLOW, isAlwaysFollow } from "./notes/units.js";
import { alwaysFollowBacked } from "./notes/always-follow-gate.js";
import { formatOverlap, maybeRefreshBranches, overlapsWith, pushedWhen, readBranchCache, refreshBranches } from "./notes/branches.js";
import { ensureRepoTrail, LEARNINGS_DIR } from "./notes/repo-trail.js";
import type { AskResult } from "./ask/ask.js";
import { setInputRate } from "./context/savings.js";
import { writeStamp } from "./upkeep.js";
import { userHome } from "./util/home.js";

const program = new Command();

/** What `init` and `uninstall` write with. Loaded when one of them runs, not at start-up (see cli-wiring.ts). */
let wiring!: typeof import("./cli-wiring.js");
async function loadWiring(): Promise<void> {
  wiring = await import("./cli-wiring.js");
}
const currentVersion = readCurrentVersion(import.meta.url);

/**
 * Started as `trail` rather than `graft`. Decided once, before any command is
 * registered, because it changes which commands exist: under trail the old
 * `graft trail …` group moves to the top level, `check` hands its name to the
 * team check (the freshness check is `build --check`), and `stats` and
 * `trail status` become one `status`. Under graft nothing moves.
 */
const TRAIL = brand() === "trail";

/** Help-screen groups under trail; graft keeps its one flat list. */
const GROUP = {
  find: "Find code · your agent runs these:",
  memory: "Learnings:",
  setup: "Setup:",
  ci: "CI:",
} as const;

/** Put a command in a help group, under trail only. */
function grouped(c: Command, heading: string): Command {
  if (TRAIL) c.helpGroup(heading);
  return c;
}

/** Price this session's tokens for a retrieval command, and pass the repo straight through so call
 *  sites stay one line. */
function noteQuery(dir: string): string {
  // Every retrieval command funnels through here, which makes it the one place
  // that can price this session's tokens before a formatter needs the number.
  setInputRate(sessionInputRate(dir));
  return dir;
}

program
  .name(brand())
  .description(
    TRAIL
      ? "A code map for your coding agents, and the learnings each session leaves\n" +
          "in your repo's .trail/, so everyone's Claude in the repo starts from them."
      : "Build a repo's context graph as linked markdown, and keep it in sync with the code.",
  )
  .version(currentVersion, "-v, --version")
  .option("--dir <path>", "context graph directory (default: <repo>/graft)")
  .option("--provider <name>", "LLM wire format: openai | anthropic | litellm | orcarouter (env GRAFT_PROVIDER)")
  .option("--model <id>", "model id for the LLM pass (env GRAFT_MODEL)")
  .option("--api-key <key>", "provider API key (env GRAFT_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible endpoint URL (env GRAFT_BASE_URL)");

interface GlobalOpts {
  dir?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Config drawn from the global CLI flags (env + defaults fill the rest). */
function cliConfig(): EngineConfig {
  const o = program.opts<GlobalOpts>();
  return {
    contextDir: o.dir,
    provider: o.provider as ProviderKind | undefined,
    model: o.model,
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
  };
}

const engineFrom = (): Graft => new Graft(cliConfig());

/**
 * Warn (never fail) when a user's `-e` extension has no parser, so it is never a silent
 * no-op — `graft build -e ".vue"` used to accept it, index nothing, and exit 0. The
 * supported set is listed so `-e` also answers "what is actually supported".
 */
function warnUnsupportedExtensions(exts?: string[]): void {
  if (!exts?.length) return;
  const bad = unsupportedExtensions(exts);
  if (bad.length === 0) return;
  for (const e of bad) {
    const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
    console.error(`⚠ -e "${shown}": no parser registered for this extension, so it is ignored.`);
  }
  console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

/** Text for the omitted-`[dir]` case, shared by every query command's help. */
const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a graft/ index)"] as const;

/**
 * The root a query runs against: the dir the user named, else the nearest
 * ancestor holding a graft index (`graph/root.ts`) so a shell or agent session
 * in a subdirectory still finds the graph. The walk is announced on stderr —
 * answering from an ancestor's graph must never be silent.
 */
function queryRoot(dir?: string): string {
  if (dir !== undefined) return resolve(dir);
  const { root, levels } = nearestGraftRoot(process.cwd(), program.opts<GlobalOpts>().dir);
  if (levels > 0) console.error(`${tag()} no code map here: answering from ${contextDirFor(root, program.opts<GlobalOpts>().dir)}`);
  return root;
}

/**
 * Bring the graph up to date with the working tree before a query answers from it
 * — the same gate the MCP tools run (see `graph/refresh.ts`). Cheap when nothing
 * moved; a structural, $0 rebuild when it did. The note goes to stderr so `--json`
 * stdout stays machine-readable.
 */
async function refreshBefore(dir: string, opts: { refresh?: boolean }): Promise<void> {
  const globalDir = program.opts<GlobalOpts>().dir;
  const root = resolve(dir);
  const disabled = opts.refresh === false;
  const ws = readWorkspace(root, globalDir);
  const r = ws
    ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled })
    : await ensureFreshGraph(root, { contextDir: globalDir, disabled });
  const note = refreshNote(r);
  if (note) console.error(note);
}

/** Attached to every query command: `--no-refresh` answers from the graph exactly
 * as it is on disk, no rebuild. */
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check: answer from the graph as-is"] as const;

const VIZ_TABS = ["context", "code", "outline"] as const;
type VizTab = (typeof VIZ_TABS)[number];

/**
 * `--tabs context,code` → the tabs to write into an exported page.
 *
 * An unknown name is a caller mistake worth failing on rather than silently
 * dropping: a page exported with a typo'd tab list would be missing a tab and
 * nothing would say why. Undefined means "all of them", which is the default the
 * exporter already applies.
 */
function parseTabs(raw: string | undefined): VizTab[] | undefined {
  if (raw === undefined) return undefined;
  const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = want.filter((t) => !VIZ_TABS.includes(t as VizTab));
  if (bad.length > 0 || want.length === 0) {
    console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? `, not "${bad.join('", "')}"` : ""}`);
    process.exit(1);
  }
  return want as VizTab[];
}

/**
 * Commands that own the upgrade story themselves (`version`, `upgrade`) or must
 * not editorialize on stderr at startup (`mcp` runs its own upkeep at boot).
 */
const UPKEEP_SKIP = new Set(["version", "upgrade", "mcp", "hook", "hooks"]);

/** Every other command: the rename and stranded-repo notices, for a person at a terminal. */
program.hook("preAction", (_parent, action) => {
  if (UPKEEP_SKIP.has(action.name())) return;
  // Someone typing graft by hand learns its new name, once a day. Agents,
  // hooks, CI and pipes never see it (see graftNotice).
  const renamed = graftNotice({ ran: spelling(action), tty: Boolean(process.stderr.isTTY) });
  if (renamed) console.error(renamed);
  // Someone typing trail in a repo whose graft-era hooks can't reach it learns
  // the one command that moves it (init itself is that command).
  const stranded = action.name() === "init" ? null : strandedRepoNotice({ cwd: process.cwd(), tty: Boolean(process.stderr.isTTY) });
  if (stranded) console.error(stranded);
});

/** `graft ask`, `graft build`: a command as graft spells it, whatever ran it. */
function spelling(action: Command): string {
  const words: string[] = [];
  for (let c: Command | null = action; c && c.parent; c = c.parent) words.unshift(c.name());
  return ["graft", ...words].join(" ");
}

// Hidden: spawned detached by maybeRefreshBranches.
program
  .command("_trail-branches", { hidden: true })
  .description("internal: fetch, then note which files teammates' open branches change and the learnings they carry")
  .argument("[dir]", "target repo directory", ".")
  .action((dir: string) => {
    refreshBranches(resolve(dir), { prs: true });
  });

// What a Claude Code plugin's hooks run (see `hooks print`). The bin answers it before this file loads (bin/trail.ts);
// registered here too so `graft hook` and `--help` know it. Fails open: whatever goes wrong, the exit code is 0.
program
  .command("hook", { hidden: true })
  .description("internal: run one Claude Code hook event, reading its payload on stdin; always exits 0")
  .argument("[event]", "the hook event, like session-start, prompt, pre-bash, post-edit or stop")
  .action(async (event?: string) => {
    await (await import("./claude/hook-entry.js")).runHookCommand(event);
  });

// The skill file `trail init` writes to ~/.claude/skills/trail, for a plugin that ships it itself.
grouped(program.command("skill"), GROUP.setup)
  .description("The skill file trail init writes for Claude Code")
  .command("export")
  .description("write the SKILL.md trail init would write to ~/.claude/skills/trail/ into --out DIR, so a plugin can ship it")
  .requiredOption("--out <dir>", "the folder to write SKILL.md into")
  .action((o: { out: string }) => {
    const dir = resolve(o.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillTemplate("trail"));
    console.log(join(dir, "SKILL.md"));
  });

grouped(program.command("hooks"), GROUP.setup)
  .description("The hooks a Claude Code plugin registers instead of trail init")
  .command("print")
  .description("print, as JSON, the `hooks` object for a plugin's hooks/hooks.json: the events, matchers and timeouts trail init would register, each running `trail hook <event>`")
  .action(() => {
    console.log(JSON.stringify(pluginHooks(), null, 2));
  });

// Hidden under trail, where -v says the same; listed under graft as it was.
program
  .command("version", { hidden: TRAIL })
  .description("Print the installed version")
  .action(() => {
    console.log(`${brand()} ${currentVersion}`);
  });

grouped(program.command("upgrade"), GROUP.setup)
  .description("This fork does not update itself: it updates through the Claude Code plugin")
  .action(() => {
    console.log("This build of trail is updated through its Claude Code plugin, not from npm: nothing is installed or fetched here.");
  });

grouped(program.command("build"), GROUP.setup)
  .description(
    TRAIL
      ? "Rebuild the code map in .trail/cache/ ($0, no key). --check fails if it's stale; --deep adds LLM summaries."
      : "Build graft/ from your code: wiring graph + per-file cards ($0, no key). " +
          "Add --deep for the LLM concept map + per-symbol summaries/crux.",
  )
  .argument("[dir]", "repository root", ".")
  .option("--check", "build nothing: fail if graft/ is stale relative to the code (for CI)")
  .option("--json", "with --check: output the drift as JSON")
  .option("--deep", "run the LLM pass: concept nodes (graft/*.md) + per-symbol summary/crux")
  .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".ts" ".py"); an extension with no parser is ignored with a warning that lists the supported set')
  .option("-j, --concurrency <n>", "files summarized in parallel during --deep (default 5)")
  .option(
    "--synth-concurrency <n>",
    "concept synthesis batches in flight at once during --deep (default 4). Separate from -j: " +
      "each synthesis call carries a whole batch of summaries, not one file",
  )
  .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
  .option("--lsp", "add compiler-grade call edges via a language server if one is installed (opt-in, slower; e.g. rust-analyzer, clangd)")
  .option("--allow-partial", "with --deep: exit 0 even when some files' summaries failed (default: a degraded meaning tier exits 1)")
  .option(
    "--follow-submodules",
    "include initialized Git submodules recursively; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-submodules",
    "exclude Git submodules; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--follow-nested-repos",
    "include nested Git clones the index does not track (a multi-repo manifest checkout, or any repo cloned into the tree) " +
      "as ONE graph, so imports across them resolve; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-nested-repos",
    "exclude untracked nested Git clones; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--include-dir <name>",
    "override SKIP_DIRS for this repo's walks, repeatable (e.g. --include-dir build --include-dir tools); " +
      "persisted, so a later build (and the hooks/refresh path) include it without the flag; dot-dirs are never overridable",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--only-dir <path>",
    "only index files under this repo-relative path, repeatable; the wiring walk and the --deep " +
      "concept pass both honor it. Recorded in the graph fingerprint so a later build " +
      "(and the hooks/refresh path) walks the same set; everything outside the list is skipped",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--no-gitignore", "skip writing graft/ into .gitignore (same as GRAFT_NO_GITIGNORE=1)")
  .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as GRAFT_NO_IGNORE=1)")
  .action(async (
    dir: string,
    opts: {
      check?: boolean;
      json?: boolean;
      deep?: boolean;
      extensions?: string[];
      concurrency?: string;
      reuse?: boolean;
      lsp?: boolean;
      allowPartial?: boolean;
      synthConcurrency?: string;
      includeDir?: string[];
      onlyDir?: string[];
      followSubmodules?: boolean;
      followNestedRepos?: boolean;
      gitignore?: boolean;
      ignore?: boolean;
    },
    command: Command,
  ) => {
    if (opts.check) {
      // The freshness check, which was `graft check`; the dir defaults like a query's.
      await runCheckCommand(command.args[0], { extensions: opts.extensions, json: opts.json }, cmd("graft check"));
      return;
    }
    if (opts.gitignore === false) process.env.GRAFT_NO_GITIGNORE = "1";
    if (opts.ignore === false) process.env.GRAFT_NO_IGNORE = "1";
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency)) : undefined;
    if (opts.concurrency && !Number.isFinite(concurrency)) {
      console.error(`✗ --concurrency must be a number, got "${opts.concurrency}"`);
      process.exit(1);
    }
    const synthConcurrency = opts.synthConcurrency ? Math.max(1, Number(opts.synthConcurrency)) : undefined;
    if (opts.synthConcurrency && !Number.isFinite(synthConcurrency)) {
      console.error(`✗ --synth-concurrency must be a number, got "${opts.synthConcurrency}"`);
      process.exit(1);
    }
    warnUnsupportedExtensions(opts.extensions);
    // Persisted BEFORE the build itself runs, so this invocation's walks (and
    // every later no-flag build / hooks refresh) see it identically — the
    // walkDir call sites read it from state, not from a threaded option.
    const buildConfigPatch: BuildConfig = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
      // --include-dir takes bare SKIP_DIRS-style directory NAMES (shouldSkipDir
      // compares a single path segment), never paths, and dot-dirs are never
      // overridable at all (see the option's own help text) — reject anything
      // else up front instead of silently persisting a value that can never
      // match a real directory name.
      for (const name of opts.includeDir) {
        if (name.startsWith(".")) {
          console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
          process.exit(1);
        }
        if (name.includes("/") || name.includes("\\")) {
          console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
          process.exit(1);
        }
      }
      buildConfigPatch.includeDirs = opts.includeDir;
    }
    // The whitelist is NOT persisted to `.graft/config.json`: it belongs with the
    // graph (the fingerprint records it at build time), never in the source repo,
    // so a `--only-dir` build leaves no trace under the repo being indexed.
    let onlyDirs: string[] | undefined;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
      // --only-dir takes a repo-relative path prefix, normalized to the same
      // posix, no-`./`, no-trailing-slash form `--in` uses, so the prefix match
      // is exact. A prefix that normalizes to "" (a bare "/" or ".") is rejected:
      // it would mean "match nothing" or "match everything", neither of which is
      // a deliberate whitelist.
      const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
      if (normalized.length === 0) {
        console.error("✗ --only-dir: expected a non-empty repo-relative path");
        process.exit(1);
      }
      onlyDirs = normalized;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
      buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
    if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
      buildConfigPatch.followNestedRepos = opts.followNestedRepos;
    }
    if (Object.keys(buildConfigPatch).length > 0) {
      patchBuildConfig(resolve(dir), buildConfigPatch);
    }
    const engine = engineFrom();
    const fmt = (o: Record<string, number>) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");

    // --deep needs a key; without one, degrade to the $0 structural build.
    let deep = opts.deep;
    const resolved = resolveConfig(cliConfig());
    if (deep && !resolved.apiKey) {
      deep = false;
      console.error(
        "⚠ no API key set, so falling back to the structural build (no LLM summaries).\n" +
          "  Set GRAFT_API_KEY (and GRAFT_PROVIDER / GRAFT_BASE_URL / GRAFT_MODEL for your\n" +
          `  provider) and re-run \`${cmd("graft build --deep")}\` to add concept nodes and summaries.`,
      );
    }
    if (deep && resolved.usedLegacyEnv) {
      console.error(
        "⚠ using OPENROUTER_API_KEY (deprecated): prefer GRAFT_API_KEY + GRAFT_BASE_URL.",
      );
    }

    // Workspace parent: build each child into its OWN graft/ + a workspace index.
    const buildRoot = resolve(dir);
    const buildGlobalDir = program.opts<GlobalOpts>().dir;
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
      await runWorkspaceBuild(buildRoot, {
        deep: !!deep,
        extensions: opts.extensions,
        concurrency,
        synthConcurrency,
        childConfig: cliConfig(),
        override: buildGlobalDir,
        includeDirs: opts.includeDir,
        followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
        followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
        packageName: readPackageName(import.meta.url),
      });
      return;
    }

    // --deep: concept nodes first, then the wiring graph links cards up to them.
    let conceptErrors: string[] = [];
    let conceptFatal: string | undefined;
    if (deep) {
      const c = await engine.init(dir, {
        extensions: opts.extensions,
        onlyDirs,
        synthConcurrency,
        onProgress: ({ phase, index, total, file }) =>
          process.stderr.write(
            `\r${phase === "summarize" ? "reading" : "writing"} concepts ${index + 1}/${total}: ${file.slice(0, 40).padEnd(40)}`,
          ),
      });
      process.stderr.write("\n");
      const conceptLine = `concepts: ${c.nodes} nodes, ${c.links} links from ${c.files} files (${c.summarized} read, ${c.cached} cached)`;
      if (c.nodes === 0) console.error(`⚠ ${conceptLine}`);
      else console.log(`✓ ${conceptLine}`);
      for (const e of c.errors) console.error(`✗ ${e}`);
      conceptErrors = c.errors;
      conceptFatal = c.fatal;
    }

    // Wiring graph — always; LLM meaning only with --deep.
    const g = await engine.graph(dir, {
      llm: deep,
      concurrency,
      reuse: opts.reuse,
      lsp: opts.lsp,
      onlyDirs,
      onProgress: ({ phase, index, total, file }) =>
        process.stderr.write(
          `\r${phase === "enrich" ? "summarizing" : "parsing"} ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`,
        ),
    });
    process.stderr.write("\n");
    console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    // Worth one line: this build started from a graph the user never built *here*.
    if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    if (deep) {
      const m = g.meaning;
      console.log(`  meaning: ${m.computed} computed, ${m.cached} cached, ${m.stale} stale, ${m.pending} pending`);
    }
    console.log(`  → ${g.contextDir}`);
    for (const e of g.errors) console.error(`✗ ${e}`);
    // A language whose depth grammar didn't load was parsed by its breadth stand-in:
    // say which, and the install that fixes it. Nothing when everything loaded.
    const fallbackNotice = nativeFallbackNotice(g.nativeFallback, readPackageName(import.meta.url));
    if (fallbackNotice) console.error(fallbackNotice);

    const rel = relative(process.cwd(), g.contextDir) || "graft";
    if (process.env.GRAFT_NO_GITIGNORE) {
      console.log(`  ${rel}/ is a local cache: add it to your gitignore if you want it untracked.`);
    } else {
      console.log(`  ${rel}/ is git-ignored (added automatically), a local cache; teammates run \`${cmd("graft build")}\` to get their own.`);
    }

    // #127: a --deep run whose LLM calls failed used to print the same success
    // footer and exit 0, so a quota-exhausted build looked identical to a clean
    // one and `graft check` still said "in sync" (it only ever checked Tier-1).
    // The structural graph IS still written and every successful summary is
    // cached, so this is a loud warning about a degraded tier, not a rollback.
    if (deep) {
      const m = g.meaning;
      const failed =
        m.failedFiles > 0 || m.fatal !== undefined || conceptErrors.length > 0 || conceptFatal !== undefined;
      if (failed) {
        const ready = m.computed + m.cached;
        const total = ready + m.stale + m.pending;
        const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
        console.error("");
        console.error(`✗ the deep pass did not complete, so the meaning tier is incomplete.`);
        if (conceptFatal) console.error(`  concepts: ${conceptFatal}`);
        if (m.fatal) console.error(`  summaries: ${m.fatal}`);
        if (m.failedFiles > 0) {
          const skipped = m.skippedFiles > 0 ? `, ${m.skippedFiles} never attempted` : "";
          console.error(`  ${m.failedFiles} file(s) failed to summarize${skipped}.`);
        }
        if (conceptErrors.length > 0) console.error(`  ${conceptErrors.length} concept-pass error(s).`);
        console.error(`  meaning coverage: ${ready}/${total} symbols (${pct}%).`);
        console.error(
          `  Nothing computed was lost: re-run \`${cmd("graft build --deep")}\` to resume from what is cached.\n` +
            "  Pass --allow-partial to accept a degraded meaning tier and exit 0.",
        );
        if (!opts.allowPartial) process.exitCode = 1;
      }
    }
  });

/**
 * After `ask`, under trail: which shown learnings are a teammate's, and the
 * lookup recorded (the learnings shown are a use, which is what the team page
 * counts as reuse; the tokens saved ride along). Then the background upkeep
 * that keeps branches current. Spawns no git itself. Teammates' branches come up after an edit
 * instead, once there's a function to compare (notes/edit-overlap.ts).
 */
function afterAsk(r: AskResult, repo: string): void {
  if (!r.notesChecked) return;
  rememberRepo(repo);
  maybeRefreshBranches(repo);
  const me = noteAuthor(repo);
  const shown = r.notes ?? [];
  if (shown.length) {
    for (const h of shown) h.note.teammate = !!h.note.author && !!me && h.note.author !== me;
  }
}

grouped(program.command("ask"), GROUP.find)
  .description("Query the graft/ graph: returns ranked nodes + exact file:line, routed to prose or wiring ($0, no key)")
  .argument("<query>", "what you want to understand, in plain words (- reads it from stdin)")
  .argument(...DIR_ARG)
  .option("-n, --limit <n>", "max results", "8")
  .option("--source", "inline the source at each file:line hit (retriever mode: the pack IS the answer, no need to re-open files)")
  .option("--full", "with --source: inline whole definition spans instead of the default ≤8-line crux excerpts")
  .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)")
  .option("--json", "output the result as JSON")
  .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank (ablation/eval)")
  .option(...NO_REFRESH_FLAG)
  .action(async (query: string, dirArg: string | undefined, opts: { limit: string; source?: boolean; full?: boolean; in?: string; json?: boolean; refresh?: boolean; graphRank?: boolean }) => {
    // The prompt hook passes what the person typed on stdin, out of sight of `ps`.
    if (query === "-") query = readFileSync(0, "utf8").trim();
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const askGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, askGlobalDir)) {
      runWorkspaceAsk(dir, askGlobalDir, query, {
        limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, json: opts.json,
      });
      return;
    }
    const engine = engineFrom();
    let r;
    try {
      r = engine.ask(dir, query, { limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, graphRank: opts.graphRank });
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    // Teammates' branches on the same files, and the learnings shown, counted as a use.
    if (TRAIL) afterAsk(r, dir);
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const { formatAsk } = await import("./ask/ask.js");
      process.stdout.write(formatAsk(r));
    }
  });

grouped(program.command("skeleton"), GROUP.find)
  .description("Signatures-only view of one file from the wiring graph: the cheapest way to see a file's API surface")
  .argument("<file>", "repo-relative path (or unique basename) of the file")
  .argument(...DIR_ARG)
  .option("--json", "output the result as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (file: string, dirArg: string | undefined, opts: { json?: boolean; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { skeleton, formatSkeleton } = await import("./ask/ask.js");
    const globalOpts = program.opts<{ dir?: string }>();
    const r = skeleton(dir, file, { contextDir: globalOpts.dir });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else process.stdout.write(formatSkeleton(r));
  });

if (!TRAIL) {
  program
    .command("check")
    .description("Fail if graft/ is stale relative to the code (for CI)")
    .argument(...DIR_ARG)
    .option("-e, --extensions <exts...>", "code extensions to include")
    .option("--json", "output the drift as JSON")
    .action(async (dirArg: string | undefined, opts: { extensions?: string[]; json?: boolean }) => {
      await runCheckCommand(dirArg, opts, "graft check");
    });
}
// Under trail, `check` is the team check (teamCheckCommand); the freshness
// check is `trail build --check`.

/**
 * The freshness check: `graft check`, and `trail build --check`. `label` is how
 * the report names the command, so each name prints its own spelling.
 */
async function runCheckCommand(
  dirArg: string | undefined,
  opts: { extensions?: string[]; json?: boolean },
  label: string,
): Promise<void> {
    warnUnsupportedExtensions(opts.extensions);
    const dir = noteQuery(queryRoot(dirArg));
    const checkGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, checkGlobalDir)) {
      await runWorkspaceCheck(dir, checkGlobalDir);
      return;
    }
    const engine = engineFrom();
    const r = engine.check(dir, { extensions: opts.extensions });
    const g = await engine.checkGraph(dir); // graph.json is only judged when it exists

    // A layer that IS present must be in sync; a never-built layer (keyless
    // build skips the markdown layer) is informational, not a failure.
    const bothMissing = r.missing && g.missing;
    const markdownFail = !r.missing && !r.ok;
    const wiringFail = !g.missing && !g.ok;

    if (opts.json) {
      console.log(JSON.stringify({ context: r, graph: g.missing ? null : g }, null, 2));
    } else if (bothMissing) {
      console.log(`${label}: NO GRAPH\n\nNo code map found. Run \`${cmd("graft build")}\` first.`);
    } else {
      if (r.missing) {
        console.log(
          `deep layer: not built (run \`${cmd("graft build --deep")}\` for concept nodes); the wiring graph is the source of truth`,
        );
      } else {
        console.log(formatCheckReport(r, label));
      }
      if (!g.missing) console.log("\n" + formatGraphCheckReport(g));
    }

    if (bothMissing || markdownFail || wiringFail) process.exit(1);
}

// Under trail this is part of `status`; the old name still runs, unlisted.
program
  .command("stats", { hidden: TRAIL })
  .description(`Show this agent session's ${brand()}-vs-source usage mix and tokens saved`)
  .argument(...DIR_ARG)
  .option("--json", "output the session stats as JSON")
  .action((dirArg: string | undefined, opts: { json?: boolean }) => {
    // Reads local session JSON only — no graph, no network. This is how a Cursor
    // user (no statusline) sees the numbers the Claude Code bar would show, and it
    // works offline.
    const dir = queryRoot(dirArg);
    const s = latestSession(dir);
    if (opts.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(formatSessionStats(s));
  });

program
  .command("viz", { hidden: TRAIL })
  .description("Serve an interactive visualization of the context graph (and graph.json when present)")
  .argument(...DIR_ARG)
  .option("-p, --port <port>", "port to serve on", "4400")
  .option("--no-open", "don't open the browser")
  .option("--export <dir>", "write one self-contained index.html instead of serving (for CI, GitHub Pages, or a build artifact)")
  .option("--title <text>", "subtitle shown beside the repo name in an exported page (e.g. \"PR #151\")")
  .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,outline (default: all three)")
  .action(async (dirArg: string | undefined, opts: { port: string; open: boolean; export?: string; title?: string; tabs?: string }) => {
    // Flags are checked before the repository is: a typo'd `--tabs` is a mistake
    // in the command the caller just typed, and telling them to go build an index
    // first sends them off to fix the wrong thing.
    const tabs = parseTabs(opts.tabs);
    const dir = noteQuery(queryRoot(dirArg));
    const { existsSync } = await import("node:fs");
    const { resolve, basename } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { contextDirFor } = await import("./context/node-file.js");
    const { startVizServer } = await import("./viz/serve.js");

    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    const contextDir = contextDirFor(root, globalOpts.dir);
    if (!existsSync(contextDir)) {
      console.error(`✗ no context graph at ${contextDir}: run \`${cmd("graft build --deep")}\` first`);
      process.exit(1);
    }
    const viewerDir = fileURLToPath(new URL("./viewer/", import.meta.url)); // prebuilt

    if (opts.export) {
      const { exportViz } = await import("./viz/export.js");
      const out = exportViz({
        contextDir,
        viewerDir,
        outDir: resolve(opts.export),
        repoName: basename(root),
        subtitle: opts.title,
        tabs,
      });
      const kb = Math.round(out.bytes / 1024);
      console.log(
        `${cmd("graft viz")} → ${out.file} (${kb} kB, ${out.contextNodes} concept nodes, ${out.codeNodes} code nodes)`,
      );
      return;
    }

    const srv = await startVizServer({
      contextDir,
      viewerDir,
      port: Number(opts.port),
      repoName: basename(root),
    });
    console.log(`${cmd("graft viz")} → ${srv.url}  (ctrl-c to stop)`);
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [srv.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  });

program
  .command("mcp", { hidden: TRAIL })
  .description("Serve the graph over MCP (stdio): exposes graft_find_code, graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map and graft_check_freshness as tools")
  .argument(...DIR_ARG)
  .action(async (dirArg: string | undefined) => {
    const { startMcpServer } = await import("./mcp/server.js");
    const dir = noteQuery(queryRoot(dirArg));
    const globalOpts = program.opts<{ dir?: string }>();
    startMcpServer(dir, globalOpts.dir, currentVersion);
  });

grouped(program.command("callers"), GROUP.find)
  .description(
    "Who calls/references a symbol ($0, no LLM). --direction out gives callees (what it calls); --depth N (or all) walks transitively for full blast radius",
  )
  .argument("<symbol>", "bare name, qualified (Class.method), or package-qualified (pkg.Fn)")
  .argument(...DIR_ARG)
  .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
  .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
  .option("--in <path>", "narrow matches to nodes at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      symbol: string,
      dirArg: string | undefined,
      opts: { direction?: string; depth?: string; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (!opts.json && readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceCallers(dir, globalOpts.dir, symbol, {
          direction: opts.direction === "out" ? "out" : "in",
          depth: opts.depth
            ? (/^(all|full|max)$/i.test(opts.depth) ? Number.POSITIVE_INFINITY : Number(opts.depth))
            : undefined,
          in: opts.in,
        });
        return;
      }
      const { runCallersCommand } = await import("./graph/traverse-cli.js");
      runCallersCommand(symbol, dir, {
        direction: opts.direction,
        depth: opts.depth,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

grouped(program.command("blast"), GROUP.ci)
  .description(
    "Blast radius of a diff: what depends on the lines this change touched ($0, no LLM). " +
      "Built for CI: `--format markdown` is a PR comment with a Mermaid diagram.",
  )
  .argument(...DIR_ARG)
  .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: the working tree vs HEAD")
  .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
  .option("--format <fmt>", "text (default) | markdown | mermaid | json")
  .option("--name", "name the affected areas with one cached LLM call (needs GRAFT_API_KEY); without it, areas are named after their hub symbol")
  .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html, for CI, GitHub Pages, or an artifact)")
  .option("--title <text>", "subtitle beside the repo name on the exported page (e.g. \"PR #171\")")
  .option("--no-owners", "do not suggest who to tag (by default, git history names the people behind each affected area)")
  .option("--pr-author <who...>", "GitHub login, git name or email of the PR author, so they are left out of their own suggestions")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { base?: string; depth?: string; format?: string; name?: boolean; exportViz?: string; title?: string; owners?: boolean; prAuthor?: string[]; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { runBlastCommand } = await import("./blast/blast-cli.js");
    await runBlastCommand(dir, {
      base: opts.base,
      depth: opts.depth,
      format: opts.format,
      name: opts.name,
      exportViz: opts.exportViz,
      title: opts.title,
      owners: opts.owners,
      prAuthor: opts.prAuthor,
      globalDir: program.opts<GlobalOpts>().dir,
    });
  });

grouped(program.command("grep"), GROUP.find)
  .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, no LLM)")
  .argument("<pattern>", "regex pattern (or literal string with --fixed)")
  .argument(...DIR_ARG)
  .option("-i, --ignore-case", "case-insensitive match")
  .option("--fixed", "treat pattern as a literal string, not a regex")
  .option("--in <path>", "narrow to files at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      pattern: string,
      dirArg: string | undefined,
      opts: { ignoreCase?: boolean; fixed?: boolean; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceGrep(dir, globalOpts.dir, pattern, {
          ignoreCase: opts.ignoreCase, fixed: opts.fixed, json: opts.json,
        });
        return;
      }
      const { runGrepCommand } = await import("./search/grep-cli.js");
      runGrepCommand(pattern, dir, {
        ignoreCase: opts.ignoreCase,
        fixed: opts.fixed,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

grouped(program.command("map"), GROUP.find)
  .description(
    "Token-budgeted repo orientation: directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, no LLM)",
  )
  .argument(...DIR_ARG)
  .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { json?: boolean; maxDirs?: string; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    let maxDirsW: number | undefined;
    if (opts.maxDirs !== undefined) {
      const n = parseInt(opts.maxDirs, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
        process.exit(1);
        return;
      }
      maxDirsW = n;
    }
    await refreshBefore(dir, opts); // after arg validation: a bad flag shouldn't cost a rebuild
    if (!opts.json && readWorkspace(root, globalOpts.dir)) {
      runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW });
      return;
    }
    const { buildRepoMap, formatRepoMap } = await import("./graph/map.js");
    const contextDir = contextDirFor(root, globalOpts.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
      console.error(`✗ no graph: run ${cmd("graft build")} first`);
      process.exit(1);
      return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW });
    if (opts.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(formatRepoMap(map));
  });

// `trail note`: what a session worked out, saved for the next person. Listed
// under trail; under graft it still runs, unlisted, for a teammate on graft in
// a repo where someone else set up trail.
grouped(program.command("note", { hidden: !TRAIL }), GROUP.memory)
  .description("Save what this session decided, tried and ruled out, as a learning in the repo's .trail/learnings/ (the text on stdin)")
  .requiredOption("--title <text>", "what the session was about, in a few words")
  .option("-m, --body <text>", "the learning itself, instead of stdin")
  .option("--personal", "about your own setup or habits, not the code: keep it in ~/.trail, out of the repo")
  .option("--always-follow", "the person says it must hold even if someone asks otherwise: Claude won't go against it (only on their word)")
  .option("--touches <list>", "comma-separated files or file#Symbol it's about (default: the files this session changed, in every repo it changed)")
  .option("--author <name>", "who wrote it (default: the first word of git config user.name)")
  .option("--minutes <n>", "what it took to work out, when the agent's transcript can't say")
  .option("--tokens <n>", "the same, in tokens")
  .option("--replaces <file>", "an earlier learning this one takes over from (its file name in .trail/learnings/); the old file stays")
  .option("--anyway", "save it even if trail's checks (names code, says why, not status, not a repeat) turn it away")
  .option("--json", "print the saved learning as JSON")
  .argument("[dir]", "repository root", ".")
  .action(async (dir: string, opts: NoteOptions) => {
    await runNoteCommand(resolve(dir), opts);
  });

// `trail skills` (design 1.7): the skills Trail kept for you, held ones to keep, offers and the switch; and
// `trail forget <name>`, the undo every save line names. The person-only ones refuse an agent (cli-skills.ts).
// Loading the skills commands costs about a tenth of a second, and a hook's child process starts this file for every query.
// They are registered when something asks for them: `skills`, `forget`, help, or no command at all.
const SKILLS_ASKED = process.argv.slice(2).some((a) => a === "skills" || a === "forget" || a === "help" || a === "-h" || a === "--help") || process.argv.slice(2).every((a) => a.startsWith("-"));
if (SKILLS_ASKED) (await import("./skills/cli-skills.js")).registerSkillCommands(program);
for (const c of program.commands) if (c.name() === "skills") grouped(c, GROUP.memory);

grouped(program.command("init"), GROUP.setup)
  .description(
    TRAIL
      ? "Wire trail into your agents: instruction files and MCP for each, plus hooks and a statusline for Claude Code"
      : "Wire Graft into the AI coding agents used with this repo (instruction files + MCP server; full hooks + statusline + MCP for Claude Code)",
  )
  .argument("[dir]", "target repo directory", ".")
  .option("--no-build", "skip building the graph (wire files only)")
  .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude), or auto: repo files for Claude Code, Cursor, Codex and OpenCode, plus files and laptop settings for the agents installed here`)
  .option("--all-agents", "write instruction files for every known agent, detected or not")
  .option("--no-agents", "Claude Code wiring only; skip other agents")
  .option("--list-agents", "list known agent ids and exit")
  .option("--no-mcp", "skip MCP server registration for other agents")
  .option("--no-hooks", "write no hooks: not for other agents, and for Claude Code no hook shim or hook entries in .claude/settings.json or ~/.claude (a plugin registers them: trail hooks print)")
  .option("--no-statusline", "skip writing Claude Code statusLine (keep a user-defined one); with --no-hooks, no Claude Code settings file is touched")
  .option("--no-user-skill", "don't write the skill file in ~/.claude/skills (a plugin ships it: trail skill export)")
  .option("--plugin", "a Claude Code plugin owns the hooks and the skill: --no-hooks --no-statusline --no-user-skill, nothing written under ~/.claude, and the repo records it in .trail/")
  .option("--dry-run", "print every file init would touch, then exit without writing")
  .option("-y, --yes", "skip the picker and wire every detected agent (the pre-0.8 default)")
  .option("--no-global", "skip writes outside this repo (the ~/.codex/ config + hooks)")
  .option("--verbose", "print every file written, the graph build's own output and the closing banner")
  .option("--plain", "look back without asking Claude to name what it finds")
  .option("--look-back", "look back at your past sessions again, for what isn't kept or closed yet (implies --mine-sessions)")
  .option("--mine-sessions", "learn from your past Claude Code sessions in this repo (off by default; they are read on this machine, by your own Claude Code)")
  .option("--mine-prs", "learn from the review comments on this repo's last merged PRs, through gh (off by default)")
  .action(async (dir: string, opts: InitOptions) => {
    if (opts.plugin) Object.assign(opts, { hooks: false, statusline: false, userSkill: false });
    await runInitCommand(dir, opts);
  });

// `trail init` prints this when there was no terminal to ask on (an agent ran
// it) or with --yes: the person picks what to keep from what the look-back
// found. An agent may run it only after the person answered (pre-bash checks).
program
  .command("keep", { hidden: true })
  .description("keep learnings `trail init` found: trail keep 1 3, or trail keep none")
  .argument("<numbers...>", "the numbers from the list init printed, or none")
  .action(async (numbers: string[]) => {
    // The CLI half of the keep check (src/init/keep.ts): it needs the receipt the PreToolUse half wrote.
    const r = (await import("./init/keep.js")).keepCommand(numbers, process.env);
    for (const line of r.lines) console.error(line);
    if (r.code) process.exitCode = r.code;
  });

/** Everything on stdin, or "" when nothing is piped in. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

interface NoteOptions {
  title: string;
  body?: string;
  touches?: string;
  author?: string;
  minutes?: string;
  tokens?: string;
  json?: boolean;
  personal?: boolean;
  alwaysFollow?: boolean;
  replaces?: string;
  anyway?: boolean;
}

async function runNoteCommand(repo: string, opts: NoteOptions): Promise<void> {
  const body = (opts.body ?? (await readStdin())).trim();
  if (!opts.title.trim() || !body) {
    console.error(`✗ a learning needs a --title and a body, on stdin or with -m:`);
    console.error(`  ${cmd("graft note")} --title "What it was about" <<'EOF'`);
    console.error("  ## Decided\n  …\n  ## Tried and ruled out\n  …\n  ## Watch out\n  …\n  EOF");
    process.exitCode = 1;
    return;
  }
  const wholeNumber = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`✗ ${flag} takes a number, got "${raw}"`);
      process.exit(1);
    }
    return Math.round(n);
  };
  const minutes = wholeNumber(opts.minutes, "--minutes");
  const tokens = wholeNumber(opts.tokens, "--tokens");
  // What the session spent, from the agent's own transcript when there is one,
  // counted from where the work the note names first came up; the flags win,
  // since only the agent knows for sure where its task began.
  const named = [...(opts.touches?.split(",").map((t) => t.trim()).filter(Boolean) ?? []), ...mentionedFiles(repo, body)];
  const spent = currentSessionCost(repo, undefined, Date.now(), aboutTerms(body, named));
  const cost =
    minutes !== undefined || tokens !== undefined || spent
      ? { minutes: minutes ?? spent?.minutes, tokens: tokens ?? spent?.tokens }
      : undefined;
  // Which repos it goes to: the one it was saved from, plus any other the
  // session edited. Explicit --touches means just this repo.
  const targets = opts.touches
    ? [{ dir: repo, touches: opts.touches.split(",").map((t) => t.trim()).filter(Boolean) }]
    : noteTargets(repo, spent?.edited ?? [], spent?.startedAt, spent ? { read: spent.read } : undefined).map((t) => ({
        dir: t.dir,
        // Then the files the note names, then the ones the session only read.
        touches: [...new Set([...t.touches, ...mentionedFiles(t.dir, body), ...(t.read ?? [])])].slice(0, 10),
      }));
  // A touch is a file git tracks or one this session edited: never a file
  // that was just lying around (a token, a scratch file).
  const real = (dir: string, files: string[]): string[] => {
    const tracked = trackedFiles(dir, files.map((f) => f.split("#")[0]!));
    const edited = new Set((spent?.edited ?? []).map((f) => relative(dir, f).split("\\").join("/")));
    return files.filter((f) => tracked.has(f.split("#")[0]!) || edited.has(f.split("#")[0]!));
  };
  for (const t of targets) t.touches = real(t.dir, t.touches);
  const scope = opts.personal ? "personal" : "repo";
  const primary = targets[0]!;
  const existing = listNotes(primary.dir, { branches: false });
  let old: Note | undefined;
  if (opts.replaces) {
    const want = basename(opts.replaces.trim());
    old = findLearning(existing, want);
    if (!old) {
      console.error(`✗ --replaces: no learning named ${want} here. The names are the files in .trail/learnings/.`);
      process.exitCode = 1;
      return;
    }
  }
  // What `replaces:` holds is the old learning's id (learning-fields.ts), not its file name.
  const replaces = old?.id;
  const text = `${opts.title}\n${body}`;
  const gate = gateNote(
    {
      title: opts.title,
      body,
      personal: scope === "personal",
      files: real(primary.dir, [...new Set([...mentionedFiles(primary.dir, text), ...(opts.touches ? primary.touches : [])])]),
      namesSymbol: namesRepoSymbol(primary.dir, symbolCandidates(text)),
      touches: primary.touches,
      replaces,
    },
    liveLearnings(existing).filter((n) => (n.scope ?? "repo") === scope),
  );
  if (gate.problems.length && !opts.anyway) {
    console.error("✗ not saved yet:");
    for (const p of gate.problems) console.error(`  · ${p}`);
    console.error(`Fix it and run ${cmd("graft note")} again, or add --anyway if a check is wrong.`);
    process.exitCode = 1;
    return;
  }
  const author = opts.author?.trim() || noteAuthor(repo);
  const date = new Date().toISOString().slice(0, 10);
  const always = opts.alwaysFollow ? alwaysFollowBacked(repo, opts.title) : { ok: false as const };
  // Saved by `trail note`, which is how an agent saves: src says so, and no flag changes it.
  const earlier: Note[] = [];
  const saved: Note[] = [];
  for (const t of targets) {
    earlier.push(...listNotes(t.dir));
    // Always follow is a mark on the learning: written as kind guardrail (what older files read), and
    // standing, so every session starts with it. Only on the person's word (always-follow-gate.ts).
    const mark = always.ok ? { kind: "guardrail" as const, standing: true } : {};
    saved.push(writeNote(t.dir, { title: opts.title, body, author, date, branch: currentBranch(t.dir), cost, touches: t.touches, replaces, src: "agent", ...mark }, scope));
  }
  const touches = targets.flatMap((t) => t.touches);

  if (opts.json) {
    console.log(JSON.stringify(saved.length === 1 ? saved[0] : saved, null, 2));
    return;
  }
  for (const n of saved) console.log(`✓ ${n.scope === "personal" ? "saved just for you" : "added to this repo"}${isAlwaysFollow(n) ? `, ${ALWAYS_FOLLOW}` : ""} · ${notePlace(n)}`);
  console.log(savedIdLine(saved));
  if (opts.alwaysFollow && !always.ok)
    console.log(
      `· not marked always follow: nothing the person typed this session says it must always hold. Saved as a learning; if they want it always followed, ask them, then save it again with --replaces ${saved[0]!.id} --always-follow`,
    );
  const note = saved[0]!;
  // Name a code file if the note touches one; docs are rarely what it's about.
  const about = touches.find((t) => !/\.(md|mdx|txt)$/i.test(t.split("#")[0]!)) ?? touches[0];
  const first = about ? ` that touches ${basename(about.split("#")[0]!)}` : "";
  const took = costLabel(note.cost);
  if (took && tokensWorthSaying(note.cost?.tokens)) {
    const reading = tokensLabel(readingTokens(note)).replace(" tokens", "");
    console.log(`· this ${took.replace(" to work out", " to figure out")}. the next session${first} gets it for ${reading}`);
  } else if (note.scope !== "personal") {
    console.log(`· the next session${first} starts from this, and gets to a PR ${PR_SPEEDUP}`);
  }
  // Learnings about the same files, from someone else: this one builds on theirs.
  const files = new Set(touches.map((t) => t.split("#")[0]));
  const prior = liveLearnings(earlier).find((n) => n !== old && n.author !== note.author && n.touches.some((t) => files.has(t.split("#")[0])));
  if (prior) console.log(`· builds on ${prior.author ? `${prior.author}'s` : "a"} learning from ${shortDate(prior.date)}`);
  if (!SECTIONS.some((s) => sectionLead(body, s.heading) !== null))
    console.log("· tip: learnings read best under ## Decided, ## Tried and ruled out and ## Watch out");
  for (const w of gate.warnings) console.log(`· ${w}`);
  if (old) console.log(`· takes over from ${noteName(old)}, which stays as the record`);
  const repoSaved = saved.filter((n) => n.scope === "repo");
  if (repoSaved.length) {
    // Who else works on these files, for the case for committing it.
    const lines = commitLines(note, teammatesOn(repo, [...files].filter((f): f is string => !!f)));
    console.log(`${lines.uncommitted} · git add ${repoSaved.map(notePlace).join(" ")}`);
    if (!process.stdout.isTTY && TRAIL)
      console.log(
        `[trail] Close your reply with one line, word for word. If this learning is committed by the end of your turn: ${lines.committed}\n` +
          `  If it isn't: ${commitAsk(note.title, about)}\n` +
          "  On a yes, commit it with the change: in the change's own commit when that isn't pushed yet.",
      );
  } else {
    console.log("· just for you: kept on this machine, out of the repo");
    if (!process.stdout.isTTY && TRAIL) console.log(`[trail] Close your reply with this line, word for word: ${PERSONAL_SAVED_LINE}`);
  }
  for (const t of targets) rememberRepo(t.dir);
}

/** What the agent asks after saving a team learning it hasn't committed: who reads it, and when. */
export function commitAsk(title: string, about?: string): string {
  const when = about ? `when they open ${basename(about.split("#")[0]!)}` : "on their next session here";
  return `📝 Learning: "${title.replace(/"/g, "'")}" · your teammates' Claude reads it ${when}. Commit it with this change? (y/n)`;
}

/** `graft init`'s flags, as commander hands them over. */
interface InitOptions { build?: boolean; agents?: string[]; allAgents?: boolean; listAgents?: boolean; mcp?: boolean; hooks?: boolean; statusline?: boolean; dryRun?: boolean; yes?: boolean; global?: boolean; verbose?: boolean; plain?: boolean; lookBack?: boolean; mineSessions?: boolean; minePrs?: boolean; plugin?: boolean; userSkill?: boolean }

/** Repo-relative with forward slashes, for printing. */
function shown(repo: string, path: string): string {
  return relative(repo, path).split("\\").join("/");
}

/** Agents init knows by another id: both read AGENTS.md. */
const AGENT_ALIASES: Record<string, string> = { codex: "agents", opencode: "agents" };

/** `graft init`. */
async function runInitCommand(dir: string, opts: InitOptions): Promise<{ ids: string[]; laptop: string[] } | null> {
    await loadWiring();
    if (opts.listAgents) {
      for (const id of [...hostIds(), "claude"]) console.log(id);
      return null;
    }
    const repo = resolve(dir);
    // Codex and OpenCode read AGENTS.md: `--agents codex` means that wiring.
    // The name as given is kept for Trail's onboarding page.
    const asked = Array.isArray(opts.agents) ? opts.agents : undefined;
    // `--agents auto`: the website's one setup prompt, run by an agent with no one to ask.
    const auto = asked?.includes("auto") === true;
    if (auto && asked!.length > 1) {
      console.error("✗ --agents auto picks the agents itself: give it on its own, or name the agents instead");
      process.exit(1);
    }
    const explicit = asked && !auto ? [...new Set(asked.map((id) => AGENT_ALIASES[id] ?? id))] : undefined;

    // Checked before anything is written: run from the home folder, init wired
    // it, mapped every code file under it, then said to commit.
    const refusal = homeFolderRefusal(repo);
    if (refusal) {
      console.error(refusal);
      process.exitCode = 1;
      return null;
    }
    if (explicit) {
      const validIds = [...hostIds(), "claude"];
      const unknown = explicit.filter((id) => !validIds.includes(id));
      if (unknown.length) {
        console.error(`✗ unknown agent id(s): ${unknown.join(", ")}; valid: ${validIds.join(", ")}`);
          process.exit(1);
      }
    }

    // Which agents to wire, decided before anything is written. Explicit flags
    // win; otherwise prompt on a TTY, and on a pipe write nothing rather than
    // guessing (pre-0.8 this silently wired every agent the machine had ever
    // installed — see --yes to get that back).
    const home = userHome();
    const plan = wiring.planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const noAgents = (opts as { agents?: unknown }).agents === false;

    // auto: the main agents' repo files plus the laptop's; out-of-repo writes only for `laptop`, the agents installed here and the caller.
    const autoSel = auto ? autoSelection({ home, repo }) : null;
    const laptop = autoSel?.laptop;
    let ids: string[];
    if (autoSel) ids = autoSel.repo;
    else if (explicit) ids = explicit;
    else if (opts.allAgents) ids = plan.map((p) => p.id);
    else if (noAgents) ids = ["claude"];
    else if (opts.yes || opts.dryRun) ids = detectedIds;
    else if (process.stdin.isTTY && process.stderr.isTTY) {
      const picked = await wiring.runPicker(plan, repo, home);
      if (picked === null) {
        console.error("· cancelled, nothing written");
        return null;
      }
      ids = picked.hosts;
    } else {
      console.error(wiring.formatNonInteractiveHelp(detectedIds));
      return null;
    }

    // Workspace parent: every child repo gets its OWN wiring too. A session
    // opens at a repo root, not at the parent, and reads `.claude/` from there —
    // wiring only the parent leaves each child with no skill, hooks, or MCP.
    // The parent's own wiring stays (queries there federate across children).
    const children = isWorkspaceBuildRoot(repo, program.opts<GlobalOpts>().dir)
      ? discoverWorkspaceChildren(repo)
      : [];
    // Parent FIRST: its build is the workspace build, which builds every child's
    // graph, so each child's own `buildGraphIfMissing` then finds one and no-ops.
    const targets = [repo, ...children.map((c) => join(repo, c))];

    if (opts.dryRun) {
      if (autoSel)
        console.error(`· --agents auto: repo files for Claude Code, Cursor, Codex and OpenCode; laptop settings for ${autoSel.agents.length ? agentList(autoSel.agents) : "none (no agent found here)"}\n`);
      console.error(wiring.formatPlan(laptopOnly(plan, laptop), ids, repo, home));
      for (const child of children)
        console.error(`\n· ${child}/ (workspace child)\n` + wiring.formatPlan(laptopOnly(wiring.planInit(join(repo, child), { home }), laptop), ids, join(repo, child), home));
      return null;
    }
    if (ids.length === 0) {
      console.error("· no agents selected, nothing written");
      return null;
    }

    const wantClaude = ids.includes("claude");
    const cliPath = fileURLToPath(import.meta.url);

    // D120 (2): what each checkout holds before init writes, so its install record names only init's own changes.
    const installSnaps = TRAIL ? wiring.snapInit(targets, home) : [];
    // Under trail, each repo gets its `.trail/learnings/`, committed with the
    // code, and its folder in ~/.trail for personal learnings and corrections.
    // Before the look-back below sends its first event: that makes the repo one
    // on trail, so the event's repo id lands in `.trail/cache/` and not in a
    // `graft/` that nothing ignores.
    const notesHome = new Map<string, { created: boolean; dir: string }>();
    if (TRAIL)
      for (const target of targets) {
        const { place } = ensureRepoHome(target);
        const created = place.git ? ensureRepoTrail(place.checkout) : false;
        notesHome.set(target, { created, dir: place.git ? place.checkout : place.dir });
        if (place.git) maybeRefreshBranches(place.checkout);
      }

    // Under trail, with Claude Code picked: look back at this repo's past
    // sessions and PR reviews while the rest of init runs, and offer what came
    // up at the end. Nothing is kept without a tick (see src/init/review.ts).
    const tty = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    // Past Claude sessions are on this laptop only where Claude Code is.
    const { beginLookBack, finishLookBack } = await import("./init/run.js");
    const mineSessions = opts.mineSessions === true || opts.lookBack === true;
    const minePrs = opts.minePrs === true;
    const lookBack = TRAIL && wantClaude && (!laptop || laptop.includes("claude")) ? beginLookBack(repo, { plain: opts.plain === true, again: opts.lookBack === true, mineSessions, minePrs }) : null;
    for (const line of lookBack?.lines ?? []) console.error(line);
    if (lookBack && !(mineSessions && minePrs)) {
      const off = [!mineSessions && "your past Claude Code sessions", !minePrs && "this repo's pull requests"].filter(Boolean).join(" or ");
      const flags = [!mineSessions && "--mine-sessions", !minePrs && "--mine-prs"].filter(Boolean).join(" and/or ");
      console.error(`· not reading ${off}: add ${flags} to trail init to learn from ${!mineSessions && !minePrs ? "them" : "it"}`);
    }
    if (children.length)
      console.error(`· workspace: wiring ${repo} and ${children.length} child repo(s): ${children.join(", ")}`);

    // Today's output, file by file, behind --verbose. Everything else gets one
    // line per step: the graph, then one per agent.
    const verbose = opts.verbose === true;
    const reports: WireReport[] = [];
    for (const target of targets) {
      if (verbose && target !== repo) console.error(`\n· ${relative(repo, target)}/`);
      reports.push(wireTarget(target, ids, { home, cliPath, plan, opts, wantClaude, quiet: !verbose, laptop }));
    }
    if (verbose && autoSel) console.error(`✓ ${autoSummary(autoSel.agents)}`);

    // The graph, built once after the wiring: a workspace parent's build is
    // the workspace build, so it covers every child.
    let graphLine: string | null = null;
    if (!verbose) {
      const res = await wiring.buildGraphWithProgress(repo, { build: opts.build, cliPath });
      for (const m of res.messages) console.error(m);
      const existing = res.built ? null : loadGraphCached(contextDirFor(repo, children.length ? undefined : program.opts<GlobalOpts>().dir));
      const fmt = (x: number) => x.toLocaleString("en-US");
      if (res.graph) {
        graphLine = `✓ graph built · ${fmt(res.graph.nodes)} nodes, ${fmt(res.graph.edges)} edges${res.graph.files ? ` from ${fmt(res.graph.files)} file${res.graph.files === 1 ? "" : "s"}` : ""}`;
      } else if (res.built) {
        graphLine = "✓ graph built";
      } else if (res.failed) {
        graphLine = `⚠ the graph build failed: run ${cmd("graft build")} to see why`;
      } else if (existing) {
        graphLine = `✓ graph ready · ${fmt(existing.meta.nodeCount)} nodes, ${fmt(existing.meta.edgeCount)} edges`;
      } else if (hasGraftIndex(repo)) {
        graphLine = "✓ graph ready";
      } else {
        graphLine = `· skipped the graph build: run ${cmd("graft build")}`;
      }
    }
    // After the graph build too: it adds the map's ignore lines (`.trail/.gitignore` under trail, `.gitignore` and `.ignore`
    // under graft), and those are init's writes.
    wiring.recordInit(installSnaps);

    if (!verbose) {
      // Warnings and removals in full, whatever else is folded.
      const removed = [...new Set(reports.flatMap((r) => r.retracted))];
      for (const id of removed) console.error(`- removed ${id} (agent not selected)`);
      for (const w of reports.flatMap((r) => r.warnings)) console.error(w);
      const writesFor = (id: string) =>
        (plan.find((p) => p.id === id)?.writes ?? []).filter((w) => opts.global !== false || w.scope !== "global");
      if (graphLine) console.error(graphLine);
      if (autoSel) console.error(`✓ ${autoSummary(autoSel.agents)}`);
      else {
        const width = Math.max(...ids.map((id) => id.length));
        for (const id of ids) {
          const summary = wiring.compactWrites(writesFor(id), repo, home);
          console.error(`✓ ${id.padEnd(width)}   ${summary}`.trimEnd());
        }
      }
    }

    // Under trail: what the look-back found, and #662's team rows (what
    // reviewers kept flagging on merged PRs, and Claude Code's notes about the
    // repo on this machine), what the person kept, where this repo's learnings
    // are, and how many there already are.
    let learnedNow = false;
    let teamSaved = 0;
    if (lookBack) {
      const screen = tty;
      const learned = await finishLookBack(repo, lookBack.reads, { yes: opts.yes === true, verbose: opts.verbose === true, say: (l) => console.error(l), ...(screen ? { io: { stdin: process.stdin, stdout: process.stderr } } : {}) });
      // #662's lines for the team rows it kept with no screen, in its words.
      const { fromReviews, fromSessions, fromMemory } = learned.teamKept ?? { fromReviews: null, fromSessions: null, fromMemory: null };
      if (fromReviews?.saved.length) {
        const n = fromReviews.saved.length;
        const what = n < fromReviews.offered ? `kept ${n} of the ${fromReviews.offered} learnings` : `${n} learning${n === 1 ? "" : "s"}`;
        console.error(`✓ ${what} from this repo's pull requests`);
        // saveReviewFindings keeps the findings' order.
        fromReviews.saved.forEach((note, i) => {
          const prs = fromReviews.kept[i]?.prs ?? [];
          console.error(`    for your team · ${note.title}${prs.length ? ` (${prs.map((n) => `#${n}`).join(", ")})` : ""}`);
        });
      }
      if (fromSessions?.saved.length) {
        const n = fromSessions.saved.length;
        console.error(`✓ ${n < fromSessions.offered ? `kept ${n} of the ${fromSessions.offered} learnings` : `${n} learning${n === 1 ? "" : "s"}`} from your past Claude sessions here`);
        for (const note of fromSessions.saved) console.error(`    for your team · ${note.title}`);
      }
      if (fromMemory?.saved.length) {
        console.error(`✓ kept ${fromMemory.saved.length} of the ${fromMemory.offered} notes your Claude keeps about this repo`);
        for (const note of fromMemory.saved) console.error(`    ${note.scope === "personal" ? "just for you " : "for your team"} · ${note.title}`);
      }
      learnedNow = learned.kept > 0;
      teamSaved = learned.team;
      if (learnedNow) {
        console.error("· Claude follows them from your next session");
        if (learned.inRepo) console.error(commitLines({}, teammatesOn(repo), "repo").uncommitted);
      }
    }
    if (TRAIL && !learnedNow) {
      const home = notesHome.get(repo);
      if (home) {
        const learnings = liveLearnings(listNotes(repo, { branches: false })).filter((n) => n.scope === "repo");
        if (learnings.length === 0) console.error(`✓ learnings  ${LEARNINGS_DIR}/ · a session that fixes a bug, takes a correction or opens a PR leaves one there, for your whole team`);
        else console.error(`✓ learnings  ${learnings.length} in ${LEARNINGS_DIR}/, from ${new Set(learnings.map((n) => n.author || "someone")).size} ${new Set(learnings.map((n) => n.author)).size === 1 ? "person" : "people"}`);
      }
    }

    if (!verbose) {
      // What there is to commit: the top-level entries the picked agents wrote.
      const tops: string[] = [];
      for (const w of wiring.selectedWrites(plan, ids)) {
        if (w.scope !== "repo") continue;
        const rel = shown(repo, w.path);
        // trail's Claude Code setup shares one file in .claude/; the rest there is personal.
        if (TRAIL && rel.startsWith(".claude/") && rel !== ".claude/settings.json") continue;
        const parts = rel.split("/");
        const top = TRAIL && rel === ".claude/settings.json" ? rel : parts.length > 1 ? `${parts[0]}/` : parts[0]!;
        if (!tops.includes(top)) tops.push(top);
      }
      console.error(`· restart your agents so a new session picks up ${brand()}`);
      if (TRAIL && !tops.includes(".trail/")) tops.push(".trail/");
      // Only what git sees as new or changed: a teammate's init over committed files has nothing to commit.
      const changedTops = tops.filter((t) => {
        const r = spawnSync("git", ["status", "--porcelain", "--", t], { cwd: repo, encoding: "utf8" });
        return r.status !== 0 || r.stdout.trim().length > 0;
      });
      tops.splice(0, tops.length, ...changedTops);
      // Outside git there is nothing to commit to, and `git status` failing above
      // made every path look changed.
      if (TRAIL && !children.length && !isGitWorkTree(repo)) console.error(NOT_GIT_LINE);
      else if (tops.length)
        console.error(
          TRAIL
            ? `· commit ${tops.slice(0, 5).join(" and ")}${tops.length > 5 ? ` +${tops.length - 5} more` : ""} once: after that, teammates' Claude reads your learnings even before they install trail`
            : `· commit ${tops.slice(0, 5).join(" ")}${tops.length > 5 ? ` +${tops.length - 5} more` : ""} to share it: graft/ stays local and git-ignored`,
        );
    }

    // One epilogue for the whole run. A workspace parent holds no nodes of its
    // own, so the totals come from the children — the graph the user actually got.
    const globalDir = program.opts<GlobalOpts>().dir;
    const graphs = (children.length ? children.map((c) => join(repo, c)) : [repo])
      .map((d) => loadGraphCached(contextDirFor(d, children.length ? undefined : globalDir)))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    if (verbose) console.error(
      "\n" +
        formatInitEpilogue({
          graphBuilt: graphs.length > 0,
          nodes: graphs.reduce((n, g) => n + g.meta.nodeCount, 0),
          edges: graphs.reduce((n, g) => n + g.meta.edgeCount, 0),
        }),
    );
    // Run by an agent, not a person: the last line tells it to ask about the
    // commit, since the person never saw the picker and Claude Code folds the rest.
    if (teamSaved && !process.stderr.isTTY)
      console.error(
        `→ ${teamSaved} team learning${teamSaved === 1 ? "" : "s"} in ${LEARNINGS_DIR}/ ${teamSaved === 1 ? "isn't" : "aren't"} committed yet. Ask the user: "Commit ${teamSaved === 1 ? "it" : `the ${teamSaved}`} so your teammates' Claude starts from ${teamSaved === 1 ? "it" : "them"}? (yes / no)"`,
      );
    // Sorted so `claude,cursor` and `cursor,claude` aggregate as one value.
    return { ids, laptop: laptop ?? ids };
}

/** A plan with the out-of-repo writes only for `laptop`'s hosts; the plan itself when every host may write there. */
function laptopOnly(plan: ReturnType<typeof PlanInit>, laptop: string[] | undefined): ReturnType<typeof PlanInit> {
  if (!laptop) return plan;
  return plan.map((p) => (laptop.includes(p.id) ? p : { ...p, writes: p.writes.filter((w) => w.scope === "repo") }));
}

/** What one target's wiring did, for the compact summary to report. */
interface WireReport {
  /** Hosts whose files were removed because they were not selected. */
  retracted: string[];
  /** ⚠ lines, printed in full. */
  warnings: string[];
}

/** One repo's worth of `init` writes — the parent, then each workspace child. */
function wireTarget(
  repo: string,
  ids: string[],
  ctx: {
    home: string;
    cliPath: string;
    plan: ReturnType<typeof PlanInit>;
    wantClaude: boolean;
    opts: { build?: boolean; mcp?: boolean; hooks?: boolean; global?: boolean; statusline?: boolean; userSkill?: boolean };
    /** Collect warnings and removals instead of printing a line per file, and
     *  leave the graph build to the caller (see buildGraphWithProgress). */
    quiet?: boolean;
    /** When given, only these hosts write outside the repo (`--agents auto`). */
    laptop?: string[];
  },
): WireReport {
    const { home, cliPath, plan, wantClaude } = ctx;
    const quiet = ctx.quiet === true;
    const opts = quiet ? { ...ctx.opts, build: false } : ctx.opts;
    const report: WireReport = { retracted: [], warnings: [] };
    // Every per-file line goes through here; in quiet mode only ⚠ lines survive.
    const say = (line: string) => {
      if (!quiet) console.error(line);
      else if (line.startsWith("⚠")) report.warnings.push(line);
    };
    const wantStatusline = statuslineWanted({ statusline: opts.statusline });

    // Converge, don't just add. init writes the selected hosts; without this it
    // never touches the rest, so a repo wired by an older version (or by the same
    // version with different --agents) keeps that run's files forever — and
    // `reconcileWiring` then keeps them *up to date*, which is worse than stale.
    // Retract every host NOT being written now; `exclude` spares the ones about to
    // be rewritten, and the graph cache is kept (init is one step from using it).
    const retracted = wiring.changed(
      wiring.runRetract(repo, { home, apply: true, global: opts.global, cache: false, exclude: ids }),
    ).filter((r) => r.action !== "skipped-unparseable");
    for (const r of retracted) say(`- removed ${r.path} (${r.what}): agent not selected`);
    report.retracted = [...new Set(retracted.map((r) => r.hostId))];

    if (wantClaude) {
      // `global`/`home` are threaded through alongside `statusline`: the claude layer
      // writes under `~/.claude` now (hosts/claude-global.ts), so --no-global has to
      // reach it or the flag would silently mean "no out-of-repo writes, except three".
      const claudeGlobal = opts.global !== false && (!ctx.laptop || ctx.laptop.includes("claude"));
      const res = wiring.runInit(repo, { build: opts.build, cliPath, statusline: wantStatusline, hooks: opts.hooks, userSkill: opts.userSkill, global: claudeGlobal, home, brand: brand() });
      say(`✓ wrote ${res.settingsPath}`);
      for (const s of res.shims) say(`✓ wrote ${s}`);
      if (res.skill) say(`✓ wrote ${res.skill}`);
      if (!res.mcp) {
        // trail registers no server for Claude Code: the hooks and the `trail` command cover it.
      } else if (res.mcp.action === "skipped-unparseable")
        say(`⚠ .mcp.json: ${res.mcp.path} left unchanged (not valid JSON); add the graft server manually`);
      else if (res.mcp.action === "unchanged")
        say(`· mcp claude: ${res.mcp.path} (already registered)`);
      else
        say(`✓ mcp claude: ${res.mcp.path} (${res.mcp.action}); restart Claude Code to load the graft MCP server`);
      say(res.built ? `✓ built the graph (${cmd("graft build")})` : "· skipped graph build");
      if (!wantStatusline) say("· skipped Claude Code statusLine (--no-statusline)");
      for (const w of res.warnings) say(`⚠ ${w}`);
    }

    // `ids` is already resolved, so hosts init is always driven by an explicit
    // list — never by its own detection fallback.
    const others = ids.filter((id) => id !== "claude");
    if (others.length > 0) {
      const r = wiring.runHostsInit(repo, {
        agents: others,
        home,
        mcp: opts.mcp,
        hooks: opts.hooks,
        global: opts.global,
        laptop: ctx.laptop,
        brand: brand(),
      });
      for (const w of r.written) say(`✓ ${w.id}: ${w.path} (${w.action})`);
      for (const m of r.mcp) say(`✓ mcp ${m.id}: ${m.path} (${m.action})`);
      for (const h of r.hooks) say(`✓ hook ${h.id}: ${h.path} (${h.action})`);
      // Phase 2 (4.17, Q3): Codex runs Trail's hooks only once the person trusts them in /hooks.
      if (r.hooks.some((h) => h.id === "codex-hooks")) {
        const trust = codexTrustLine({ ...process.env, HOME: home, CODEX_HOME: process.env.CODEX_HOME || join(home, ".codex") });
        // A ⚠ line, so the short output keeps it too: until then Trail does nothing in Codex.
        if (trust) say(`⚠ ${trust}`);
      }
      // Only worth saying when there was actually something out-of-repo to skip.
      if (opts.global === false && wiring.selectedWrites(plan, ids).some((w) => w.scope === "global"))
        say("· skipped out-of-repo writes (--no-global)");
    }

    // Record WHICH graft wrote this repo's agent files, and under which flags.
    // Every entry point compares this against the running binary and re-writes
    // them on a mismatch, so an `npm i -g` upgrade reaches the hooks/skill/rules
    // too — not just the binary. The flags ride along so a refresh replays the
    // user's choices (notably --no-global) instead of overriding them.
    writeStamp(repo, currentVersion, ids, {
      global: opts.global !== false,
      mcp: opts.mcp !== false,
      hooks: opts.hooks !== false,
      statusline: wantStatusline,
      ...(ctx.laptop ? { laptop: ctx.laptop } : {}),
    });

    // Every host's wiring points at graft/, so the graph is built whatever was
    // selected — not only when Claude Code is in the list (runInit does its own).
    if (!wantClaude) {
      if (!quiet)
        say(
          wiring.buildGraphIfMissing(repo, { build: opts.build, cliPath })
            ? `✓ built the graph (${cmd("graft build")})`
            : "· skipped graph build",
        );
    }
    return report;
}

/** Group a retraction report by host, so the output reads as "what leaves each agent". */
function formatRetractions(rs: Retraction[], apply: boolean): string {
  const hit = wiring.changed(rs);
  if (hit.length === 0) return "· nothing to remove: no graft wiring found here";
  const verb = apply ? "removed" : "would remove";
  const lines: string[] = [];
  const byHost = new Map<string, Retraction[]>();
  for (const r of hit) {
    const k = byHost.get(r.hostId) ?? [];
    k.push(r);
    byHost.set(r.hostId, k);
  }
  for (const [host, items] of byHost) {
    lines.push(`\n${host}:`);
    for (const r of items) {
      const mark =
        r.action === "skipped-unparseable"
          ? "⚠"
          : r.action === "deleted"
            ? "-"
            : "~";
      const note =
        r.action === "skipped-unparseable"
          ? ": not valid JSON, left untouched (remove the graft entry by hand)"
          : r.action === "deleted"
            ? ` (${r.what}, deleted)`
            : ` (${r.what})`;
      const scope = r.scope === "global" ? " [machine-wide]" : "";
      lines.push(`  ${mark} ${verb}: ${r.path}${scope}${note}`);
    }
  }
  return lines.join("\n").replace(/^\n/, "");
}

grouped(program.command("uninstall"), GROUP.setup)
  .description(`Remove every file and config entry ${TRAIL ? "trail or graft" : "graft"} has written to this repo (the inverse of init)`)
  .argument("[dir]", "target repo directory", ".")
  .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
  .option("--keep-cache", "keep graft/ and the .gitignore entries: wiring only")
  .option("--no-global", "leave out-of-repo files alone (~/.codex, ~/.gemini)")
  .action(async (dir: string, opts: { yes?: boolean; keepCache?: boolean; global?: boolean }) => {
    await loadWiring();
    const repo = resolve(dir);
    const home = userHome();
    const common = { home, global: opts.global, cache: opts.keepCache ? false : true };

    if (!opts.yes) {
      console.error(formatRetractions(wiring.planRetract(repo, common), false));
      console.error("\nDry run: nothing was touched. Re-run with -y to remove.");
      if (opts.global !== false)
        console.error("Entries marked [machine-wide] affect every project; --no-global skips them.");
      return;
    }
    const done = wiring.runRetract(repo, { ...common, apply: true });
    console.error(formatRetractions(done, true));
    const bad = wiring.changed(done).filter((r) => r.action === "skipped-unparseable");
    console.error(
      bad.length
        ? `\n⚠ ${bad.length} file(s) could not be parsed and were left as-is: see above.`
        : `\n✓ ${brand()} fully removed. \`${cmd("graft init")}\` re-wires from scratch.`,
    );
  });


/** The repo at `repo`: its key, display name and checkout. */
function workspaceRepo(repo: string): { key: string; name: string; checkout: string; git: boolean } {
  const place = repoPlace(repo);
  return { key: place.key, name: repoName(place.key, place.checkout), checkout: place.checkout, git: place.git };
}

/* -------------------------------------------------------------------------- */
/* trail team · trail check                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fold a long line at `width`, indenting what wraps. The text holds a
 * learning's or a teammate's words, and any word can start a line, so it's
 * one line first and no word starts with a `[trail]`-style marker (flatten.ts).
 */
function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of unmarkedWords(text)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = indent + word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

function teamCommand(name = "team"): Command {
  return new Command(name)
    .description("What the team learned this week, who's working on what, and where work overlaps")
    .argument("[dir]", "repository root", ".")
    .option("--days <n>", "how far back to look", "7")
    .option("--json", "output as JSON")
    .action((dir: string, opts: { days: string; json?: boolean }) => {
      const days = Math.max(1, Math.min(90, Number(opts.days) || 7));
      localTeam(resolve(dir), days, opts.json === true);
    });
}

/** Pairs of teammates' pushed branches that change the same files, from this clone's branch cache. */
function branchOverlapTexts(repo: string, now = Date.now()): string[] {
  const branches = readBranchCache(repo)?.branches ?? [];
  const out: string[] = [];
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const a = branches[i]!;
      const b = branches[j]!;
      if (!a.author || !b.author || a.author === b.author) continue;
      const shared = a.files.filter((f) => !f.startsWith(".trail/") && b.files.includes(f));
      if (!shared.length) continue;
      const files = shared.length <= 2 ? shared.join(" and ") : `${shared.slice(0, 2).join(", ")} and ${shared.length - 2} more`;
      out.push(
        `${a.author}'s ${a.ref.replace(/^origin\//, "")} (pushed ${pushedWhen(a.at, now)}) and ${b.author}'s ${b.ref.replace(/^origin\//, "")} (pushed ${pushedWhen(b.at, now)}) both change ${files}`,
      );
      if (out.length >= 5) return out;
    }
  }
  return out;
}

/**
 * `trail team`: what this clone can see on
 * its own. Who wrote which learnings lately, and where teammates' pushed
 * branches overlap.
 */
function localTeam(repo: string, days: number, json: boolean): void {
  maybeRefreshBranches(repo);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent = listNotes(repo).filter((n) => n.scope === "repo" && n.date >= since);
  const byAuthor = new Map<string, Note[]>();
  for (const n of recent) byAuthor.set(n.author || "someone", [...(byAuthor.get(n.author || "someone") ?? []), n]);
  const overlaps = branchOverlapTexts(repo);
  if (json) {
    console.log(JSON.stringify({ days, learnings: recent.length, members: [...byAuthor].map(([name, ns]) => ({ name, learnings: ns.length, titles: ns.map((n) => n.title) })), overlaps }, null, 2));
    return;
  }
  const here = workspaceRepo(repo);
  console.log(`${days === 7 ? "this week" : `the last ${days} days`} in ${here.name} · from this clone`);
  console.log(`${byAuthor.size} ${byAuthor.size === 1 ? "person" : "people"} · ${recent.length} new learning${recent.length === 1 ? "" : "s"}`);
  if (byAuthor.size) {
    console.log("");
    const nameW = Math.max(...[...byAuthor.keys()].map((k) => k.length)) + 3;
    for (const [name, ns] of byAuthor) {
      const latest = ns[0]!.title.length > 40 ? `${ns[0]!.title.slice(0, 39)}…` : ns[0]!.title;
      console.log(`  ${name.padEnd(nameW)}${latest.padEnd(42)}${ns.length} learning${ns.length === 1 ? "" : "s"}`);
    }
  }
  if (overlaps.length) {
    console.log("\noverlap");
    for (const o of overlaps) for (const [i, l] of wrap(o, 66, "    ").entries()) console.log(i === 0 ? `  ● ${l}` : l);
  }
}

function teamCheckCommand(name = "check"): Command {
  return new Command(name)
    .description("Check your branch's diff against the learnings that bear on it: this repo's, yours, and the skills")
    .argument("[dir]", "repository root", ".")
    .option("--base <ref>", "compare against where the branch left this ref (default: origin's default branch)")
    .option("--json", "output as JSON")
    .action(async (dir: string, opts: { base?: string; json?: boolean }) => {
      await runTeamCheck(resolve(dir), opts);
    });
}

/** A unified diff without the sections for `.trail/` files: a learning is never the change being checked. */
function withoutTrailFiles(diff: string): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((part) => !/^diff --git a\/\.trail\//.test(part))
    .join("");
}

/**
 * `trail check`, on this machine: the branch's diff against the learnings in
 * the repo's `.trail/` (teammates' pushed branches included), this person's
 * own, and the repo's skills. No sign-in, no server. Exits 1 on a conflict.
 */
async function runTeamCheck(dir: string, opts: { base?: string; json?: boolean }): Promise<void> {
  // From the top of the checkout: git names changed files from there, and a learning's touches have to
  // line up with them exactly to fail the check. From a folder inside, none ever would.
  const repo = checkoutRoot(dir) ?? dir;
  const d = branchDiff(repo, opts.base);
  if (!d) {
    console.error("✗ not a git repository");
    process.exitCode = 1;
    return;
  }
  const files = d.files.filter((f) => !f.startsWith(".trail/"));
  const me = noteAuthor(repo);
  // Learnings this branch changed, as they were before it: the check reads those,
  // and changing a teammate's is a finding of its own.
  const atBase = learningsAtBase(repo, d.from, d.files);
  const edits = teammateEdits(repo, atBase, me);
  if (files.length === 0 && edits.length === 0) {
    console.log(`· nothing to check: no changes against ${d.base}`);
    return;
  }
  maybeRefreshBranches(repo);
  if (d.truncated) console.error("⚠ the diff is over 400 KB; only the first 400 KB is checked");
  // Replaced and retired learnings are left out after the swap, so a branch can't retire a learning by editing it.
  const notes = withBaseLearnings(listNotes(repo), atBase);
  const r = checkLocally({ diff: withoutTrailFiles(d.diff), files, notes, skills: (await import("./skills/skills.js")).listSkills(repo), asker: me, committed: committedAtBase(repo, d.from) });
  r.findings.unshift(...edits);
  const overlaps = overlapsWith(repo, files, me).slice(0, 3);
  if (opts.json) {
    console.log(JSON.stringify({ ...r, overlaps }, null, 2));
  } else {
    printCheck(r);
    if (overlaps.length) console.log(`\n${overlaps.map((o) => formatOverlap(o)).join("\n")}`);
  }
  if (r.findings.some((f) => f.verdict === "conflict")) process.exitCode = 1;
}

function printCheck(r: CheckResult): void {
  console.log(
    `checking ${r.files} changed file${r.files === 1 ? "" : "s"} against ${r.notes} learning${r.notes === 1 ? "" : "s"} and ${r.skills} skill${r.skills === 1 ? "" : "s"}\n`,
  );
  const conflicts = r.findings.filter((f) => f.verdict === "conflict");
  const leads = r.findings.filter((f) => f.verdict === "lead");
  for (const f of [...conflicts, ...leads, ...r.findings.filter((x) => x.verdict === "follows")]) {
    const mark = f.verdict === "conflict" ? "✗" : f.verdict === "lead" ? "●" : "✓";
    console.log(`${mark} ${f.file}${f.line ? `:${f.line}` : ""}`);
    console.log(`  ${f.summary}`);
    if (f.why) console.log(`  worth a look, can't fail the check: ${f.why}`);
    if (f.replacedBy) console.log(`  this branch replaces it with ${f.replacedBy.id} ("${f.replacedBy.title}"), which counts once it's on the base branch: until then, say why in the PR`);
    const s = f.source;
    if (f.verdict !== "follows" && s.quote) {
      const who = [s.author, s.date ? shortDate(s.date) : ""].filter(Boolean).join(" · ");
      for (const l of wrap(`${who ? `${who}: ` : ""}${s.quote}`, 70, "  ")) console.log(`  ${l.trimStart()}`);
    }
  }
  if (r.findings.length === 0) console.log("✓ no learning bears on this change");
  console.log("");
  console.log(
    conflicts.length
      ? `· ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} · fix ${conflicts.length === 1 ? "it" : "them"}, or say why in the commit message or PR description`
      : `· no conflicts${leads.length ? ` · ${leads.length} worth a look` : ""}`,
  );
}

/** Tokens saved by this repo's agent sessions touched in the last 7 days. */
function savedThisWeek(repo: string, now = Date.now()): number {
  const since = now - 7 * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const id of listSessionIds(repo)) {
    try {
      if (statSync(join(sessionDir(repo), `${id}.json`)).mtimeMs < since) continue;
    } catch {
      continue;
    }
    total += readSession(repo, id).savedTokens ?? 0;
  }
  return total;
}

/** 212345 → `212k`, 1_250_000 → `1.3M`. */
function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * `trail status`: what was `graft stats`, on one
 * screen. The code map and whether it matches the code, the learnings for
 * this repo, and what the agents saved this week.
 */
function statusCommand(name = "status"): Command {
  return new Command(name)
    .description("Code map, learnings and tokens saved, on one screen")
    .argument(...DIR_ARG)
    .option("--json", "machine-readable output")
    .action(async (dirArg: string | undefined, opts: { json?: boolean }) => {
      const repo = queryRoot(dirArg);
      const graph = loadGraphCached(contextDirFor(repo, program.opts<GlobalOpts>().dir));
      const g = graph ? await engineFrom().checkGraph(repo) : null;
      const fresh = g && !g.missing ? g.ok : null;
      const kept = keepsNotes(repo);
      // Only what still holds: a retired, held or replaced learning reaches no agent.
      const all = kept ? liveLearnings(listNotes(repo)) : [];
      const inRepo = all.filter((n) => n.scope === "repo" && !n.ref).length;
      const onBranches = all.filter((n) => n.ref).length;
      const personal = all.filter((n) => n.scope === "personal").length;
      const saved = savedThisWeek(repo);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              codeMap: graph ? { nodes: graph.meta.nodeCount, inSync: fresh } : null,
              learnings: kept ? { repo: inRepo, branches: onBranches, personal } : null,
              week: { savedTokens: saved },
            },
            null,
            2,
          ),
        );
        return;
      }
      const fmt = (x: number) => x.toLocaleString("en-US");
      const row = (k: string, v: string) => console.log(`${k.padEnd(11)} ${v}`);
      if (!graph) row("code map", `✗ not built · run ${cmd("graft build")}`);
      else if (fresh === false) row("code map", `⚠ ${fmt(graph.meta.nodeCount)} nodes · behind the code, refreshed on the next query`);
      else row("code map", `✓ ${fmt(graph.meta.nodeCount)} nodes · in sync with the code`);
      if (kept) {
        const parts = [`${inRepo} added to this repo, in ${LEARNINGS_DIR}/`];
        if (onBranches) parts.push(`${onBranches} on teammates' branches`);
        if (personal) parts.push(`${personal} just for you, on this machine`);
        row("learnings", parts.join(" · "));
      }
      row("this week", saved > 0 ? `~${shortCount(saved)} tokens saved` : "nothing saved yet");
      // Phase 2 (4.17, D137): Codex's trust of Trail's hooks, and why it keeps nothing new there yet.
      for (const l of codexStatusLines()) row("codex", l);
    });
}

if (TRAIL) {
  for (const c of [teamCheckCommand(), teamCommand()]) program.addCommand(c.helpGroup(GROUP.memory));
  program.addCommand(statusCommand().helpGroup(GROUP.setup));

  // Help lists the groups in this order, and the commands within each.
  const order = ["ask", "grep", "skeleton", "callers", "map", "note", "check", "team", "skills", "init", "build", "status", "upgrade", "uninstall", "blast"];
  const rank = (c: Command) => {
    const i = order.indexOf(c.name());
    return i === -1 ? order.length : i;
  };
  (program.commands as Command[]).sort((a, b) => rank(a) - rank(b));

  // One line each in the list; `trail <command> --help` keeps the long text.
  const summaries: Record<string, string> = {
    ask: "ranked answer, with the code inlined at each file:line",
    grep: "every occurrence, grouped by enclosing symbol",
    skeleton: "a file's whole API in ~200 tokens",
    callers: "who calls it, or what it calls with --direction out",
    map: "directory clusters, hubs and hotspots",
    note: "save what this session worked out, as a learning in .trail/",
    skills: "the steps that worked, kept as skills when you say so · on, off, show, forget",
    init: "wire trail into your agents",
    build: "rebuild the code map · --check fails if it's stale",
    status: "code map, learnings and tokens saved",
    upgrade: "install the latest trail",
    uninstall: "remove everything trail or graft wrote to this repo",
    check: "check your diff against this repo's learnings and yours",
    team: "what the team learned this week, and where work overlaps",
    blast: "what depends on the lines this diff touched",
  };
  for (const c of program.commands) if (summaries[c.name()]) c.summary(summaries[c.name()]!);
  program.addHelpText("after", "\ntrail <command> --help for flags · every graft command still works");
}

program.parseAsync(process.argv).catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
