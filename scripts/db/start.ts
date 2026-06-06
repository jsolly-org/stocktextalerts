/**
 * scripts/db/start.ts — resilient local Supabase startup.
 *
 * Podman machine restarts can leave Supabase containers exited while the CLI
 * still thinks the project is running. In that state `supabase start` refuses
 * to recreate containers until `supabase stop` clears local state. Use the
 * backup-preserving stop here because `db:start` is also used for interactive
 * development; `db:bootstrap` handles destructive resets explicitly afterward.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rootLogger } from "../../src/lib/logging";
import { supabaseCliArgs } from "./supabase-cli-args";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const localSupabaseCli = path.join(projectRoot, "node_modules", ".bin", "supabase");
const supabaseExecutable = fs.existsSync(localSupabaseCli) ? localSupabaseCli : "supabase";

type CommandResult = {
	status: number;
	output: string;
	error?: Error;
};

function runSupabase(args: string[]): CommandResult {
	const result = spawnSync(supabaseExecutable, args, {
		encoding: "utf8",
		cwd: projectRoot,
	});

	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);

	if (result.error) {
		return {
			status: 1,
			output: result.error.message,
			error: result.error,
		};
	}

	return {
		status: result.status ?? 1,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

export function isStaleSupabaseState(output: string): boolean {
	return output.includes("supabase start is already running");
}

function main(): void {
	const configArgs = supabaseCliArgs();
	const firstStart = runSupabase(["start", ...configArgs]);
	if (firstStart.status === 0) return;

	if (!isStaleSupabaseState(firstStart.output)) {
		process.exit(firstStart.status);
	}

	rootLogger.warn("db:start — clearing stale Supabase container state", {
		action: "db_start_recover_stale_state",
		reason: "podman_machine_restart_left_supabase_containers_exited",
	});

	const stop = runSupabase(["stop", ...configArgs]);
	if (stop.status !== 0) {
		rootLogger.warn("db:start — supabase stop reported a non-zero exit before retry", {
			action: "db_start_recover_stale_state",
			cause: stop.error?.message ?? "supabase_stop_non_zero",
		});
	}

	const secondStart = runSupabase(["start", ...configArgs]);
	process.exit(secondStart.status);
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
	main();
}
