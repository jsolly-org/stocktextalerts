#!/usr/bin/env tsx
/**
 * scripts/check-ts.ts — run `astro check` and fail on Vite/Astro logger WARN
 * lines that are not counted in the diagnostic summary.
 *
 * `astro check --minimumFailingSeverity warning` already fails on type/lint
 * diagnostics. Vite can still emit `[WARN] [vite] ...` (e.g. a stale
 * `optimizeDeps.include` entry) while the summary stays at "0 warnings" and
 * exit 0. This wrapper tees stdout/stderr and fails closed on any `[WARN]`.
 *
 * Exit codes: 0 — clean check, no logger WARNs. 1 — diagnostics failed and/or
 * a logger WARN was emitted.
 *
 * Usage: npm run check:ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// `@astrojs/check` powers `astro check`. Keep the dep referenced so knip does not
// treat it as unused after the npm script moved into this wrapper.
import "@astrojs/check";

import { runWithLoggerWarnGate } from "./logger-warn-gate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

runWithLoggerWarnGate(
	path.join(projectRoot, "node_modules", ".bin", "astro"),
	["check", "--minimumSeverity", "warning", "--minimumFailingSeverity", "warning"],
	{ action: "check_ts", cwd: projectRoot },
);
