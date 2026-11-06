/**
 * How the hooks reach the learned-skills parts (design 1.7, 3.1 to 3.5):
 * only when `~/.trail/settings.json` says skills are on, and then by
 * `import()`, so with skills off every hook pays one small file read and
 * loads none of the skills code (0 rule 1; the skills modules add about
 * 15 ms to a hook that loads them). Each part fails open: a part that
 * throws is nothing.
 *
 * PreToolUse doesn't come here: `pre-bash.ts` has its own prefilter and
 * loads nothing heavier than its fast path.
 */
import type { HookOut } from '../skills/types.js';
import { noteSkillsStarted, skillsOn, trailNow } from '../skills/settings.js';
import { detectHost } from '../trace/host.js';

/** Skills on, and hooks not turned off for Trail's own headless calls. */
export function skillsWired(env: NodeJS.ProcessEnv = process.env): boolean {
  const off = env.TRAIL_NO_HOOKS;
  if (off && off !== '0' && off.toLowerCase() !== 'false') return false;
  try {
    return skillsOn(env);
  } catch {
    return false;
  }
}

/** P36: Codex's directives name its sandbox; loaded only for a Codex payload. */
async function codexWords(out: HookOut, input: unknown): Promise<HookOut> {
  if (detectHost(input).host !== 'codex' || (!out.context && !out.block)) return out;
  const { withCodexSandbox } = await import('../hosts/codex-trust.js');
  return withCodexSandbox(out, 'codex');
}

/** 3.1, after the learnings the start text already has. */
export async function sessionStartPart(input: unknown, dir: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOut> {
  if (!skillsWired(env)) return {};
  try {
    noteSkillsStarted(env, trailNow(env));
    const { sessionStartSkillsRun } = await import('./start-skills.js');
    const r = sessionStartSkillsRun(input, dir, env);
    return r.out;
  } catch {
    return {};
  }
}

/** 3.2: before the graph ask. */
export async function promptPart(input: unknown, dir: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOut> {
  if (!skillsWired(env)) return {};
  try {
    const { promptSkills } = await import('./prompt-skills.js');
    return await codexWords(promptSkills(input, dir, env), input);
  } catch {
    return {};
  }
}

/** 3.4: PostToolUse (`failed` false, from tool-savings) or PostToolUseFailure (`failed` true) on Bash. */
export async function postBashPart(input: any, dir: string, failed: boolean, env: NodeJS.ProcessEnv = process.env): Promise<HookOut> {
  if (input?.tool_name !== 'Bash' || !skillsWired(env)) return {};
  try {
    const { postBashRun } = await import('./post-bash.js');
    const r = postBashRun(input, dir, env, failed);
    return r.out;
  } catch {
    return {};
  }
}

/** 3.4, Codex: PostToolUse on Bash for every exit (`codex-post-bash`); the exit comes from the output's header. */
export async function codexPostBashPart(input: any, dir: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOut> {
  if (input?.tool_name !== 'Bash' || !skillsWired(env)) return {};
  try {
    const { codexPostBash } = await import('./post-bash.js');
    const r = codexPostBash(input, dir, env);
    return r?.out ?? {};
  } catch {
    return {};
  }
}

/** 3.5. */
export async function stopPart(input: unknown, dir: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOut> {
  if (!skillsWired(env)) return {};
  try {
    const { stopSkillsRun } = await import('./stop-skills.js');
    const r = stopSkillsRun(input, dir, env);
    return await codexWords(r.out, input);
  } catch {
    return {};
  }
}
