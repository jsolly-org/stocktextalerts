import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("x-release-id contract", () => {
	it("middleware sets x-release-id from RELEASE_ID", () => {
		const src = readFileSync(resolve(repoRoot, "src/middleware.ts"), "utf8");
		expect(src).toContain('headers.set("x-release-id", RELEASE_ID)');
		expect(src).toContain('from "./lib/logging/release-id"');
	});

	it("gen-release-id stamps a non-dev SHA from VERCEL_GIT_COMMIT_SHA", () => {
		const sha = "abcdef1234567890deadbeef";
		execFileSync(process.execPath, ["./node_modules/.bin/tsx", "scripts/gen-release-id.ts"], {
			cwd: repoRoot,
			env: { ...process.env, VERCEL_GIT_COMMIT_SHA: sha },
			stdio: "pipe",
		});
		const stamped = readFileSync(resolve(repoRoot, "src/lib/logging/release-id.ts"), "utf8");
		expect(stamped).toContain(`RELEASE_ID = "${sha.slice(0, 12)}"`);
		expect(stamped).not.toContain('RELEASE_ID = "dev"');

		execFileSync(process.execPath, ["./node_modules/.bin/tsx", "scripts/restore-release-stub.ts"], {
			cwd: repoRoot,
			stdio: "pipe",
		});
		const restored = readFileSync(resolve(repoRoot, "src/lib/logging/release-id.ts"), "utf8");
		expect(restored).toContain('RELEASE_ID = "dev"');
	});
});
