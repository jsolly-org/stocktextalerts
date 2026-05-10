import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getLockPath } from "../lock";

describe("getLockPath", () => {
	it("returns an absolute path inside the git common directory, named test.lock", () => {
		const lockPath = getLockPath();
		expect(path.isAbsolute(lockPath)).toBe(true);
		expect(path.basename(lockPath)).toBe("test.lock");

		const expectedDir = path.resolve(
			process.cwd(),
			execFileSync("git", ["rev-parse", "--git-common-dir"], {
				cwd: process.cwd(),
				encoding: "utf8",
			}).trim(),
		);
		expect(path.dirname(lockPath)).toBe(expectedDir);
	});
});
