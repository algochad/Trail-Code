/**
 * `graft version` / `graft --version` support.
 *
 * Split out of cli.ts so the version lookups can be unit-tested.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_FOR } from "./brand.js";
import { toPosixPath } from "./util/paths.js";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * The npm package this code was installed as: `@trailhq/trail-code`, or
 * `@nanonets/graft` (the same code under its old name). Upgrades and update
 * checks go to the package actually installed, not to the name typed.
 */
export function readPackageName(moduleUrl: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolvePackageJsonPath(moduleUrl), "utf8")) as { name?: string };
    return pkg.name ?? PACKAGE_FOR.graft;
  } catch {
    return PACKAGE_FOR.graft;
  }
}


/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** True when the running module lives under an npx cache dir (e.g.
 * `~/.npm/_npx/<hash>/node_modules/...`) rather than a regular global install.
 *
 * Normalized first: `fileURLToPath` returns the *platform* separator, so on
 * Windows the cache path is `…\_npx\…` and a bare `includes("/_npx/")` is always
 * false — `graft upgrade` would then run `npm install -g` on top of an npx run.
 * Same hardcoded-`/` mistake as #33; `src/util/paths.ts` exists for exactly this. */
export function isRunningViaNpx(moduleUrl: string): boolean {
  return toPosixPath(fileURLToPath(moduleUrl)).includes("/_npx/");
}
