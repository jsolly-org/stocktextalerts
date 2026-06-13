/**
 * scripts/db/reset.ts — db:reset against the worktree's own supabase/config.toml.
 *
 * Per-worktree isolation lives in the worktree's config.toml (written + skip-worktree'd by
 * worktree-supabase.ts), which the Supabase CLI reads directly — no `--config` flag (removed in
 * CLI 2.105). See docs/superpowers/plans/2026-06-13-worktree-supabase-cli-fix.md.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isLinkedWorktree, unsafeResetMessage, worktreeSupabaseProvisioned } from "./worktree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const localSupabaseCli = path.join(projectRoot, "node_modules", ".bin", "supabase");
const supabaseExecutable = fs.existsSync(localSupabaseCli) ? localSupabaseCli : "supabase";

function run(command: string, args: string[]): number {
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	return result.status ?? 1;
}

function main(): void {
	// Fail closed: never let `db:reset` in an unprovisioned linked worktree wipe the shared stack.
	const refusal = unsafeResetMessage(isLinkedWorktree(), worktreeSupabaseProvisioned());
	if (refusal !== null) {
		process.stderr.write(`${refusal}\n`);
		process.exit(1);
	}

	const status = run(supabaseExecutable, ["status"]);
	if (status !== 0) {
		process.exit(status);
	}

	if (run("npm", ["run", "db:generate-seed"]) !== 0) {
		process.exit(1);
	}

	if (run(supabaseExecutable, ["db", "reset"]) !== 0) {
		process.exit(1);
	}

	if (run("npm", ["run", "db:gen-types"]) !== 0) {
		process.exit(1);
	}

	// Fail a fresh reset immediately on permission drift so missing service_role
	// grants / accidental client exposure surface here, not in production.
	if (run("npm", ["run", "check:db-privileges"]) !== 0) {
		process.exit(1);
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
	main();
}
