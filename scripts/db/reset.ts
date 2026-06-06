/**
 * scripts/db/reset.ts — db:reset with optional per-worktree Supabase config.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { supabaseCliArgs } from "./supabase-cli-args";

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
	const supabaseArgs = supabaseCliArgs();

	const status = run(supabaseExecutable, ["status", ...supabaseArgs]);
	if (status !== 0) {
		process.exit(status);
	}

	if (run("npm", ["run", "db:generate-seed"]) !== 0) {
		process.exit(1);
	}

	if (run(supabaseExecutable, ["db", "reset", ...supabaseArgs]) !== 0) {
		process.exit(1);
	}

	if (run("npm", ["run", "db:gen-types"]) !== 0) {
		process.exit(1);
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
	main();
}
