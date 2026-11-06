/**
 * Everything `trail init` and `trail uninstall` write with, behind one import so cli.ts can load it only when one of
 * them runs: it is a large share of the modules the CLI would otherwise load for every query a hook starts.
 */
export { buildGraphIfMissing, runInit } from "./claude/init.js";
export { runHostsInit } from "./hosts/init.js";
export { planInit, selectedWrites } from "./hosts/plan.js";
export { planRetract, runRetract, changed } from "./hosts/retract.js";
export { compactWrites, formatNonInteractiveHelp, formatPlan, runPicker } from "./cli-picker.js";
export { buildGraphWithProgress } from "./claude/build-progress.js";
export { recordInit, snapInit } from "./init/install-paths.js";
