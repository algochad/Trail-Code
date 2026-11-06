// Preload for a test: appends the URL of every file the process loads to $RECORD_LOADS_FILE.
import { register } from "node:module";

const hooks = `
import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  if (process.env.RECORD_LOADS_FILE && url.startsWith('file:')) appendFileSync(process.env.RECORD_LOADS_FILE, url + '\\n');
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);
