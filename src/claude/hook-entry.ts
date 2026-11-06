/**
 * `trail hook <event>`: what a plugin's hooks run. Reached straight from the bin, before the CLI (commander and every
 * command it knows) is loaded, because PreToolUse runs this before every shell command. Never rejects, and the exit
 * code is 0 whatever happens: a hook that fails must not stop the agent's turn.
 *
 * Each event loads only what it needs. The prompt and stop events skip hooks.ts altogether (their handlers are modules
 * of their own); hooks.ts's `main` does the same steps for the rest, through the same `beginHook`.
 */
export async function runHookCommand(event: string | undefined): Promise<void> {
  try {
    if (event === 'pre-bash') await (await import('./pre-bash.js')).main('pre-bash');
    else if (event === 'prompt' || event === 'stop') {
      const { adoptBrand, beginHook } = await import('./hook-prelude.js');
      const begun = beginHook(event);
      if (begun) {
        adoptBrand(begun.dir);
        if (event === 'prompt') await (await import('./prompt-hook.js')).handlePrompt(begun.input, begun.dir);
        else await (await import('./stop.js')).handleStopEvent(begun.input, begun.dir);
      }
    } else if (event) await (await import('./hooks.js')).main(event);
  } catch {
    // Silent on purpose.
  }
  process.exitCode = 0;
}
