import { describe, expect, it } from "vitest";
import { isStaleSupabaseState } from "../../scripts/db/start";

describe("db:start stale Supabase state detection", () => {
	it("detects the already-running message without requiring exited-container text", () => {
		expect(
			isStaleSupabaseState(
				"supabase start is already running.\nTry rerunning the command with --debug",
			),
		).toBe(true);
	});

	it("ignores unrelated startup failures", () => {
		expect(isStaleSupabaseState("failed to connect to docker daemon")).toBe(false);
		expect(isStaleSupabaseState("")).toBe(false);
	});
});
