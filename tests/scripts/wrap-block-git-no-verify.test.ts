import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
	new URL("../../scripts/agent-guards/wrap-block-git-no-verify.sh", import.meta.url),
);

type HookPayload = { command?: string };

function runHook(payload: HookPayload): { exitCode: number; stdout: string } {
	const input = JSON.stringify(payload);
	try {
		const stdout = execFileSync("bash", [scriptPath], {
			input,
			encoding: "utf8",
		});
		return { exitCode: 0, stdout: stdout.trim() };
	} catch (error: unknown) {
		const err = error as { status?: number; stdout?: string };
		return {
			exitCode: err.status ?? 1,
			stdout: (err.stdout ?? "").trim(),
		};
	}
}

describe("wrap-block-git-no-verify hook", () => {
	it("allows git fetch origin main", () => {
		const { exitCode, stdout } = runHook({
			command: "git fetch origin main",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});

	it("allows npm test", () => {
		const { exitCode, stdout } = runHook({ command: "npm test" });
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});

	it("allows hook-runner command", () => {
		const { exitCode, stdout } = runHook({
			command: "bash scripts/agent-guards/wrap-block-git-no-verify.sh",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});

	it("blocks git commit --no-verify", () => {
		const { exitCode, stdout } = runHook({
			command: "git commit --no-verify -m test",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
		expect(stdout).toContain("--no-verify");
	});

	it("blocks git push --no-verify", () => {
		const { exitCode, stdout } = runHook({
			command: "git push --no-verify",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
	});
});
