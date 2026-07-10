import { describe, expect, it } from "vitest";
import { redactSecrets, spawnAgent } from "../../scripts/janitor/spawn";

describe("janitor spawnAgent", () => {
	it("redacts common credential shapes", () => {
		const raw = [
			"token=github_pat_11AAAA_BBBB",
			"CURSOR_API_KEY=cursor-secret-value",
			"Authorization: Bearer abc.def",
			"sk-abcdefghijklmnopqrstuvwxyz012345",
		].join("\n");
		const scrubbed = redactSecrets(raw);
		expect(scrubbed).not.toContain("github_pat_11AAAA_BBBB");
		expect(scrubbed).toContain("github_pat_[REDACTED]");
		expect(scrubbed).toContain("CURSOR_API_KEY=[REDACTED]");
		expect(scrubbed).toContain("Authorization: [REDACTED]");
		expect(scrubbed).toContain("sk-[REDACTED]");
	});

	it("times out a SIGTERM-resistant process with exit 124 (SIGKILL escalation)", async () => {
		// Ignore SIGTERM so the soft-timeout path must escalate to SIGKILL.
		const result = await spawnAgent({
			cmd: "node",
			args: ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1e9)'],
			cwd: process.cwd(),
			timeoutSeconds: 1,
		});
		expect(result.exitCode).toBe(124);
		expect(result.summary).toMatch(/timed out after 1s/);
	}, 15_000);
});
