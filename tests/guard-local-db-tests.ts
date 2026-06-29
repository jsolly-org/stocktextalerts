/**
 * StockTextAlerts-only: guard against accidental local runs of DB-backed test suites.
 *
 * Other repos under ~/code follow dotagents for agent conventions; do not copy this opt-in
 * model unless that repo documents the same CI-canonical / local-debug split.
 */

export type DbTestSuite = "vitest" | "playwright";

const OPT_IN_VAR = "ALLOW_LOCAL_DB_TESTS";

export function isLocalDbTestsAllowed(): boolean {
	if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
		return true;
	}
	return process.env[OPT_IN_VAR] === "1";
}

function formatLocalDbTestsBlockedMessage(suite: DbTestSuite): string {
	const cmd = suite === "vitest" ? "npm run test:local" : "npm run test:e2e:local";
	return [
		"",
		"Local DB-backed tests are disabled by default.",
		"GitHub CI (npm test / test:e2e on PRs and main) is the canonical test runner.",
		"",
		`To run ${suite} locally for debugging:`,
		`  ${cmd}`,
		"",
		"See tests/README.md and docs/github-ci.md.",
		"",
	].join("\n");
}

export function assertLocalDbTestsAllowed(suite: DbTestSuite): void {
	if (isLocalDbTestsAllowed()) {
		return;
	}
	process.stderr.write(formatLocalDbTestsBlockedMessage(suite));
	process.exit(1);
}

const isMain =
	typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
	const suiteArg = process.argv[2];
	const suite: DbTestSuite = suiteArg === "playwright" ? "playwright" : "vitest";
	assertLocalDbTestsAllowed(suite);
}
