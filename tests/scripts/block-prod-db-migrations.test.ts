import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
	new URL("../../scripts/agent-guards/block-prod-db-migrations.sh", import.meta.url),
);

type HookPayload = { command?: string; tool_input?: { command?: string } };

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

describe("block-prod-db-migrations hook", () => {
	it("allows local Supabase workflow commands", () => {
		const { exitCode, stdout } = runHook({
			command: "supabase migration new add_users_column",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});

	it("allows npm run db:reset", () => {
		const { exitCode } = runHook({ command: "npm run db:reset" });
		expect(exitCode).toBe(0);
	});

	it("blocks supabase db push (Cursor)", () => {
		const { exitCode, stdout } = runHook({
			command: "supabase db push --include-all --yes",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
		expect(stdout).toContain("CI-only");
	});

	it("blocks supabase db push via npx", () => {
		const { exitCode, stdout } = runHook({
			command: "npx supabase db push",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
	});

	it("blocks supabase migration repair", () => {
		const { exitCode, stdout } = runHook({
			command: "supabase migration repair 20260501000000 --status reverted --linked",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
	});

	it("blocks psql", () => {
		const { exitCode, stdout } = runHook({
			command: 'psql "$DATABASE_URL_PROD" -c "SELECT 1"',
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
	});

	it("blocks supabase db push inside bash -c quoted command", () => {
		const { exitCode, stdout } = runHook({
			command: 'bash -c "supabase db push --yes"',
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
	});

	it("blocks compound commands when any segment is forbidden", () => {
		const { exitCode, stdout } = runHook({
			command: "npm run check:ts && supabase db push",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"deny"/);
	});

	it("blocks supabase db push (Claude PreToolUse)", () => {
		const { exitCode, stdout } = runHook({
			tool_input: { command: "supabase db push" },
		});
		expect(exitCode).toBe(2);
		expect(stdout).toContain("permissionDecision");
		expect(stdout).toContain("deny");
	});

	it("allows git fetch origin main", () => {
		const { exitCode, stdout } = runHook({
			command: "git fetch origin main",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});

	it("allows empty command with stdout (failClosed-safe)", () => {
		const { exitCode, stdout } = runHook({ command: "" });
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});

	it("allows hook-runner command", () => {
		const { exitCode, stdout } = runHook({
			command: "bash scripts/agent-guards/block-prod-db-migrations.sh",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/"permission":\s*"allow"/);
	});
});
