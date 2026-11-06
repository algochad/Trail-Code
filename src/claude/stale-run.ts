/**
 * The "N stale" count after an edit, worked out off to the side: `graft check` re-reads every file, which is more than
 * the post-edit hook can wait for. Started detached by the hook (`node stale-run.js <dir>`); writes the count into the
 * stats only if the edit is still unsynced, so a background rebuild that finished first is never overwritten.
 */
import { pathToFileURL } from 'node:url';
import { graftJson, withContextDirArg } from './hook-io.js';
import { patchStats, readStats } from '../util/state.js';

/** Files the check found out of step with the graph: changed, added or removed. */
export function staleCount(dir: string): number {
  const r = graftJson(dir, withContextDirArg(dir, ['check', '.', '--json']));
  const g = r?.graph ?? {};
  return (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
}

export function main(): void {
  const dir = process.argv[2];
  if (!dir) return;
  const count = staleCount(dir);
  if (readStats(dir)?.dirty) patchStats(dir, { staleCount: count });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
