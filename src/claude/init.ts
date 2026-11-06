import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, rmdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { disableGraftServerIn, installClaudeGlobal, type GlobalWrite } from '../hosts/claude-global.js';
import { mergeGraftSettings, mergeTrailShared, mergeTrailLocal, statuslineWanted } from './settings-merge.js';
import { statuslineShim, hooksShim, rememberInstall } from './shim-template.js';
import { skillTemplate } from './skill-template.js';
import { mergeJsonKey, serverEntry, type McpWrite } from '../hosts/mcp-config.js';
import { readJsonObject } from '../hosts/config-write.js';
import { ignoreInTrailDir } from '../notes/repo-trail.js';
export { ignoreInTrailDir };
import { hasGraftIndex } from '../graph/root.js';
import type { PlannedWrite } from '../hosts/plan.js';
import { PLUGIN_MARKER, repoWiredForTrail, type Brand } from '../brand.js';
import { userHome } from "../util/home.js";
import { claudeDir } from "../util/home.js";

/** trail's committed hook, inside `.trail/` where a `.claude/*` ignore rule can't drop it. */
export const TRAIL_HOOK = join('.trail', 'hook.cjs');
/** The status line's shim. Also in `.trail/`, but ignored there: only people with trail draw it. */
export const TRAIL_STATUSLINE = join('.trail', 'statusline.cjs');
/** Where trail's skill goes: the user's own `~/.claude`, never the repo. */
export function trailSkillPath(home: string = userHome()): string {
  return join(claudeDir(home), 'skills', 'trail', 'SKILL.md');
}

/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front.
 */
export function claudeTargets(dir: string, initBrand?: Brand, home?: string): PlannedWrite[] {
  return claudeTargetsFor(dir, wiringName(dir, initBrand), home);
}

/**
 * The name the Claude Code wiring goes by in `dir`: trail's where `trail init`
 * is wiring it now (`initBrand`) or already did, graft's everywhere else.
 * Otherwise decided by the repo, not the machine, so a teammate on graft
 * refreshing the wiring writes the same files and never flips them back.
 */
export function wiringName(dir: string, initBrand?: Brand): Brand {
  return initBrand === 'trail' || repoWiredForTrail(dir) ? 'trail' : 'graft';
}

/**
 * `claudeTargets` under one name.
 *
 * trail splits what it writes in two. Shared, committed once by whoever sets
 * the repo up: `.trail/hook.cjs` and one SessionStart entry in
 * `.claude/settings.json`, which is all a teammate without trail needs to be
 * shown the learnings and offered trail. Personal, where git never looks: the
 * status line and allowlist in `.claude/settings.local.json`, the skill in
 * `~/.claude/skills/`, and the other hooks in `~/.claude` (hosts/claude-global.ts).
 * No MCP server: the hooks and the `trail` command do what it did.
 */
export function claudeTargetsFor(dir: string, name: Brand, home: string = userHome()): PlannedWrite[] {
  if (name !== 'trail') return legacyClaudeTargets(dir, name);
  const t = (path: string, what: string): PlannedWrite => ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind: 'claude', what });
  return [
    t(join(dir, '.claude', 'settings.json'), 'trail SessionStart hook, shared'),
    t(join(dir, TRAIL_HOOK), 'hooks shim, shared'),
    t(join(dir, '.claude', 'settings.local.json'), 'trail statusline + allowlist, yours'),
    t(join(dir, TRAIL_STATUSLINE), 'statusline shim, git-ignored'),
    { hostId: 'claude', id: 'claude', path: trailSkillPath(home), scope: 'global', kind: 'claude', what: 'trail skill' },
  ];
}

/**
 * The layout every graft repo has, and trail repos had before 0.23: shims in
 * `.claude/helpers/`, the skill in `.claude/skills/`, the server in `.mcp.json`,
 * in that order. `runInit` writes it for graft; for trail it's what a refresh
 * clears away, and what uninstall removes under both names.
 */
export function legacyClaudeTargets(dir: string, name: Brand): PlannedWrite[] {
  const t = (path: string, what: string, kind: PlannedWrite['kind'] = 'claude'): PlannedWrite =>
    ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind, what });
  return [
    t(join(dir, '.claude', 'settings.json'), `${name} statusline + hook blocks`),
    t(join(dir, '.claude', 'helpers', `${name}-statusline.cjs`), 'statusline shim'),
    t(join(dir, '.claude', 'helpers', `${name}-hooks.cjs`), 'hooks shim'),
    t(join(dir, '.claude', 'skills', name, 'SKILL.md'), `${name} skill`),
    // Tagged 'mcp' so the picker doesn't label Claude Code as having no MCP.
    t(join(dir, '.mcp.json'), `mcpServers.${name}`, 'mcp'),
  ];
}

/**
 * Build the graph if it isn't there yet. Not Claude-specific: the wiring for any
 * host points at `graft/`, so `graft init` builds whichever hosts were selected —
 * this lives beside `runInit` only because that's the caller that owns `built`.
 * Best-effort; the user can always run `graft build` (the epilogue says so).
 */
export function buildGraphIfMissing(dir: string, opts: { build?: boolean; cliPath?: string }): boolean {
  // `hasGraftIndex`, not just wiring.json: a workspace parent's graph IS its
  // `workspace.json` (nodes live in the children), so testing for wiring.json
  // alone would call it unbuilt and rebuild every child on each init.
  if (opts.build === false || !opts.cliPath || hasGraftIndex(dir)) return false;
  try {
    // execArgv carries the loader graft itself was started with (tsx, when run
    // from source), so the child can run a .ts entry point too.
    execFileSync(process.execPath, [...process.execArgv, opts.cliPath, 'build', '.'], { cwd: dir, stdio: 'inherit', timeout: 300000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The repo's settings as an object to merge into: {} when missing or empty, null when it isn't plain JSON. */
function readSettings(path: string): Record<string, any> | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return {}; }
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export interface InitResult {
  settingsPath: string;
  shims: string[];
  /** Where the skill went; '' when nothing was written (trail under `--no-global`). */
  skill: string;
  /** the `.mcp.json` write registering the graft MCP server for Claude Code; trail writes none. */
  mcp: McpWrite | null;
  /** the user-level writes under `~/.claude`, empty when `global: false`. */
  global: GlobalWrite[];
  warnings: string[];
  built: boolean;
}

export function runInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; hooks?: boolean; userSkill?: boolean; global?: boolean; home?: string; brand?: Brand } = {},
): InitResult {
  if (wiringName(dir, opts.brand) === 'trail') return runTrailInit(dir, opts);
  // Same list `--dry-run` and the picker report, so the two can't drift apart.
  const [settings, statusline, hooks, skill, mcpTarget] = legacyClaudeTargets(dir, 'graft').map((t) => t.path);

  mkdirSync(dirname(statusline), { recursive: true });

  const settingsPath = settings;
  const existing = readSettings(settingsPath);
  const { merged, warnings } = mergeGraftSettings(existing ?? {}, { statusline: opts.statusline, name: 'graft' });
  // A file that isn't plain JSON (a comment, a trailing comma) is the
  // person's, and rewriting it would drop what they put there, their own
  // hooks included. Upkeep replays this at session start, so it has to hold
  // there too. The ~/.claude copy still runs the hooks.
  if (existing) writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  else warnings.push(notPlainJson('.claude/settings.json', "graft's hooks"));

  const sl = statusline;
  const hk = hooks;
  // The shims are committed, so they name nothing about this machine; where the
  // package lives here goes to the trail home instead, for them to find first.
  writeFileSync(sl, statuslineShim()); chmodSync(sl, 0o755);
  writeFileSync(hk, hooksShim()); chmodSync(hk, 0o755);
  rememberInstall(opts.home ?? userHome());

  // Install the graft skill — the piece that redirects the agent to graft/ before it
  // greps source. Overwritten each run (graft owns this file), like the shims above.
  const skillPath = skill;
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillTemplate('graft'));

  // Register the graft MCP server in the project's .mcp.json so Claude Code
  // exposes graft_find_code/graft_trace_calls/etc. as tools — the same keyed merge the
  // other hosts use (existing servers preserved; unparseable files skipped).
  const mcp = mergeJsonKey('claude', mcpTarget, 'mcpServers', serverEntry({ brand: 'graft' }), 'graft');

  // The same wiring again, one level up in `~/.claude`, because everything above
  // this line can be erased by a `.gitignore` and lost to `git worktree add`. See
  // hosts/claude-global.ts for the failure that motivates it. Gated on the same
  // flag `registerMcpConfigs` uses, so `--no-global` still means "nothing outside
  // this repo".
  const global = opts.global === false ? [] : installClaudeGlobal(opts.home ?? userHome(), 'graft');

  const built = buildGraphIfMissing(dir, opts);
  return { settingsPath, shims: [sl, hk], skill: skillPath, mcp, global, warnings, built };
}

/** The warning for a settings file init left alone because it isn't plain JSON. */
function notPlainJson(file: string, what: string): string {
  return `Left ${file} as it was: it isn't plain JSON (a comment or a trailing comma?), and rewriting it would lose what's in it. Make it plain JSON and run init again to add ${what} there.`;
}

/**
 * `runInit` for a repo on trail. Shared: `.trail/hook.cjs` and its one
 * SessionStart entry in `.claude/settings.json`. Personal: everything else.
 * Run again over a repo set up the old way, it moves it: the old shims, the
 * repo skill and trail's `.mcp.json` server go.
 */
function runTrailInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; hooks?: boolean; userSkill?: boolean; global?: boolean; home?: string },
): InitResult {
  const home = opts.home ?? userHome();
  const global = opts.global !== false;
  // `--no-hooks`: a Claude Code plugin registers the hooks (`trail hooks print`), so no hook is written anywhere,
  // and the repo says so (`.trail/plugin-managed.json`). `--no-user-skill`: no skill file in the user's `.claude` either.
  const hooks = opts.hooks !== false;
  const userSkill = opts.userSkill !== false;
  const wantStatusline = statuslineWanted(opts);
  const [settings, hook, local, statusline, skill] = claudeTargetsFor(dir, 'trail', home).map((t) => t.path);

  mkdirSync(dirname(hook), { recursive: true });
  if (hooks) { writeFileSync(hook, hooksShim()); chmodSync(hook, 0o755); }
  if (hooks || wantStatusline) {
    writeFileSync(statusline, statuslineShim()); chmodSync(statusline, 0o755);
    ignoreInTrailDir(dir, 'statusline.cjs');
  }
  // The map and its caches (`.trail/cache/`, context/map-dir.ts) are each machine's own. Said here as well as at
  // the build: a hook or `--no-build` writes the cache there before any build adds the line.
  ignoreInTrailDir(dir, 'cache/');
  rememberInstall(home);
  if (!hooks) {
    mkdirSync(join(dir, '.trail'), { recursive: true });
    writeFileSync(join(dir, '.trail', PLUGIN_MARKER), `${JSON.stringify({ hooks: 'plugin' }, null, 2)}\n`);
  }

  // Either file, when it isn't plain JSON, is the person's and stays as it is
  // (see runInit): rewriting it would drop their own hooks and settings.
  const existingShared = hooks ? readSettings(settings) : {};
  if (hooks && existingShared) {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, `${JSON.stringify(mergeTrailShared(existingShared), null, 2)}\n`);
  }

  // Hooks for every other event come from `~/.claude`. Only when that's off do
  // they go in the personal file, beside the status line.
  // With neither hooks nor a status line to write, no Claude Code settings file is touched at all.
  const warnings: string[] = [];
  if (hooks || wantStatusline) {
    const existingLocal = readSettings(local);
    const mergedLocal = mergeTrailLocal(existingLocal ?? {}, { statusline: opts.statusline, hooks: hooks && !global });
    warnings.push(...mergedLocal.warnings);
    if (existingLocal) { mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, `${JSON.stringify(mergedLocal.merged, null, 2)}\n`); }
    else warnings.push(notPlainJson('.claude/settings.local.json', "trail's status line and allowlist"));
    if (hooks && !existingShared) warnings.unshift(notPlainJson('.claude/settings.json', "trail's session-start hook"));
    keepOutOfGit(dir, join('.claude', 'settings.local.json'));
  }

  let skillPath = '';
  if (global && userSkill) {
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, skillTemplate('trail'));
    skillPath = skill;
  }

  // An old settings.json left as it was still runs the old shims: they stay until it can be rewritten.
  if (hooks) clearOldLayout(dir, { keepShims: !existingShared });

  const globalWrites = global && hooks ? installClaudeGlobal(home, 'trail') : [];
  // A trail repo on a machine with graft's server installed for everything:
  // graft goes off in this folder, so its tools don't show here.
  if (global && hooks) globalWrites.push(disableGraftServerIn(home, resolve(dir)));

  const built = buildGraphIfMissing(dir, opts);
  return { settingsPath: settings, shims: [statusline, hook], skill: skillPath, mcp: null, global: globalWrites, warnings, built };
}

/**
 * What trail wrote before 0.23 and doesn't any more: both names' shims in
 * `.claude/helpers/`, the skill in `.claude/skills/`, and trail's server in
 * `.mcp.json`. Settings entries are already gone: the merges replace them.
 */
function clearOldLayout(dir: string, opts: { keepShims?: boolean } = {}): void {
  for (const n of ['graft', 'trail'] as const) {
    const [, oldSl, oldHk, oldSkill] = legacyClaudeTargets(dir, n).map((t) => t.path);
    if (!opts.keepShims) {
      rmSync(oldSl, { force: true });
      rmSync(oldHk, { force: true });
    }
    rmSync(dirname(oldSkill), { recursive: true, force: true });
  }
  // The folders they were in, once nothing else is: rmdir refuses a non-empty one.
  for (const d of [join(dir, '.claude', 'helpers'), join(dir, '.claude', 'skills')]) {
    try { rmdirSync(d); } catch { /* holds the user's files, or was never there */ }
  }
  dropServer(join(dir, '.mcp.json'), ['trail', 'graft']);
}

/** Take trail's (or graft's) server out of an `.mcp.json`; the file goes if nothing else was in it. */
function dropServer(path: string, names: string[]): void {
  try {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable' || !loaded.existed) return;
    const root = loaded.root;
    const servers = root.mcpServers;
    if (!servers || typeof servers !== 'object' || !names.some((n) => n in servers)) return;
    for (const n of names) delete servers[n];
    if (Object.keys(servers).length === 0) delete root.mcpServers;
    if (Object.keys(root).length === 0) rmSync(path, { force: true });
    else writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  } catch { /* leave it as the user has it */ }
}

/**
 * Keep a personal file out of git without touching the repo's `.gitignore`:
 * if nothing ignores it already, it goes in `.git/info/exclude`, which is
 * never committed. A folder that isn't a git checkout is left alone.
 */
export function keepOutOfGit(dir: string, rel: string): void {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return; // exit 0: already ignored
  } catch (e) {
    if ((e as { status?: number }).status !== 1) return; // 128: not a git checkout
  }
  try {
    let exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (!isAbsolute(exclude)) exclude = join(dir, exclude);
    const line = `/${rel.split('\\').join('/')}`;
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (text.split('\n').some((l) => l.trim() === line)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* best-effort: git status shows the file, and nothing else breaks */ }
}
