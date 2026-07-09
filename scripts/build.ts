#!/usr/bin/env tsx
/**
 * scripts/build.ts — run `astro build` and fail on Vite/Astro logger WARN
 * lines that would otherwise exit 0 (same hole as `astro check`).
 *
 * Third-party Rolldown noise (e.g. @vueuse/core INVALID_ANNOTATION) is
 * suppressed in `astro.config.ts` via `vite.build.rolldownOptions.onLog`,
 * not via an allowlist here — the gate stays zero-exception.
 *
 * Usage: npm run build
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runWithLoggerWarnGate } from "./logger-warn-gate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

runWithLoggerWarnGate(path.join(projectRoot, "node_modules", ".bin", "astro"), ["build"], {
	action: "build",
	cwd: projectRoot,
});
