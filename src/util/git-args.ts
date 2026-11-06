/**
 * Git settings that change what `git diff`/`show`/`log` print, forced to their
 * defaults. A user's own config (`diff.mnemonicPrefix` writes `i/` and `w/`
 * instead of `a/` and `b/`, `diff.colorMoved` and `color.ui` add escape codes,
 * `diff.external` runs another program, `core.quotePath` escapes non-ASCII
 * paths) must never reach code that parses git's output.
 */
export const GIT_PLAIN_CONFIG: string[] = [
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.srcPrefix=a/",
  "-c", "diff.dstPrefix=b/",
  "-c", "diff.colorMoved=false",
  "-c", "color.ui=false",
  "-c", "core.quotePath=false",
];

/** Flags for `git diff`/`show`/`log -p` that stop colour and external diff drivers. */
export const GIT_PLAIN_FLAGS: string[] = ["--no-color", "--no-ext-diff"];

/**
 * `git <plain config> <subcommand> <plain flags> ...rest`, for a subcommand that
 * prints a diff (`diff`, `show`, `log`). Other subcommands only need the config.
 */
export function plainGit(args: string[]): string[] {
  const [sub = "", ...rest] = args;
  return [...GIT_PLAIN_CONFIG, sub, ...(["diff", "show", "log"].includes(sub) ? GIT_PLAIN_FLAGS : []), ...rest];
}
