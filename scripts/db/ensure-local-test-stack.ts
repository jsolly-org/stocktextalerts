/**
 * StockTextAlerts-only preflight for local DB-backed test runs (ALLOW_LOCAL_DB_TESTS=1).
 *
 * 1. Wire DOCKER_HOST to a live Podman socket (start VM if needed).
 * 2. Run db:doctor; on failure try db:start once, then doctor again.
 * 3. Exit non-zero with bootstrap hints if the stack is still unhealthy.
 *
 * CI uses docker.sock directly — this script is not invoked there (see preflight-for-tests.ts).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureContainerEngineEnv } from "./container-engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

const REPAIR_HINT = [
	"",
	"💡 Local Supabase is still unhealthy after an automatic db:start.",
	"   Full repair:  npm run db:bootstrap",
	"   (equivalent to: npm run db:start && npm run db:reset && npm run db:doctor)",
	"",
].join("\n");

function runNpmScript(script: string): number {
	const result = spawnSync("npm", ["run", script], {
		cwd: projectRoot,
		encoding: "utf8",
		env: process.env,
		stdio: "inherit",
	});
	return result.status ?? 1;
}

function main(): void {
	ensureContainerEngineEnv();

	if (runNpmScript("db:doctor") === 0) {
		return;
	}

	process.stderr.write(
		"\nensure-local-test-stack — db:doctor failed; attempting npm run db:start …\n",
	);

	if (runNpmScript("db:start") !== 0) {
		process.stderr.write(REPAIR_HINT);
		process.exit(1);
	}

	if (runNpmScript("db:doctor") === 0) {
		return;
	}

	process.stderr.write(REPAIR_HINT);
	process.exit(1);
}

const isMain =
	typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
	main();
}
