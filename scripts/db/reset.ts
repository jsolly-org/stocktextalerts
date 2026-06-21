/**
 * scripts/db/reset.ts — destructive reseed of the shared local Supabase stack.
 *
 * All worktrees share ONE local stack (default ports, project_id "stocktextalerts"); isolation
 * between worktrees' DB access is the cross-worktree test lock (<git-common-dir>/test.lock),
 * not a per-worktree stack. Because this truncates and reseeds the shared DB, it acquires that
 * same lock first — so a reset can't yank the database out from under another worktree's running
 * vitest/playwright suite (and vice-versa). See docs/plans/2026-06-21-shared-local-supabase-stack.md.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireTestLock, formatContentionMessage, TestLockHeldError } from "../../tests/lock";

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
	// Serialize against any running test suite on the shared stack. The lock auto-releases via the
	// exit/SIGINT/SIGTERM handlers lock.ts registers on acquire, so every process.exit below frees it.
	try {
		acquireTestLock("reset");
	} catch (err) {
		if (err instanceof TestLockHeldError) {
			process.stderr.write(formatContentionMessage(err));
			process.exit(1);
		}
		throw err;
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
