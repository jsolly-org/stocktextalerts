/**
 * StockTextAlerts test preflight (npm `pretest` / `pretest:e2e` after the local opt-in guard).
 *
 * Not a dotagents fleet pattern — other repos use their own test/bootstrap scripts.
 *
 * - CI: db:doctor only (GitHub Actions sets DOCKER_HOST to docker.sock).
 * - Local opt-in: ensure-local-test-stack (Podman start + doctor + optional db:start).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isLocalDbTestsAllowed } from "../../tests/guard-local-db-tests";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

function runTsxScript(scriptRelPath: string): number {
	const scriptPath = path.join(projectRoot, scriptRelPath);
	const result = spawnSync(
		process.execPath,
		["./node_modules/.bin/tsx", scriptPath],
		{
			cwd: projectRoot,
			encoding: "utf8",
			env: process.env,
			stdio: "inherit",
		},
	);
	return result.status ?? 1;
}

function main(): void {
	if (!isLocalDbTestsAllowed()) {
		// Guard should have exited already; defensive only.
		process.exit(1);
	}

	const isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
	const status = isCi
		? runTsxScript("scripts/db/doctor.ts")
		: runTsxScript("scripts/db/ensure-local-test-stack.ts");

	process.exit(status);
}

const isMain =
	typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
	main();
}
