import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/lib/logging";

describe("logging contract", () => {
	it("emits level=error JSON that metric filters and alert-hub accept", () => {
		vi.stubEnv("LOG_MASK_PII", "true");
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			createLogger({ job: "contract-test" }).error(
				"boom",
				{ recipient: "+12793212870" },
				new Error("kaboom"),
			);

			const [first] = spy.mock.calls[0];
			const parsed = JSON.parse(first as string);
			expect(parsed.level).toBe("error");
			expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(parsed.message).toBe("boom");
			expect(parsed.error).toMatchObject({ name: "Error", message: "kaboom" });
			expect(JSON.stringify(parsed)).not.toContain("+12793212870");
		} finally {
			spy.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	it("redacts sensitive-named keys nested inside error.raw", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const postgrestLike = {
				message: "duplicate key value violates unique constraint",
				code: "23505",
				details: "Key (email)=(user@example.com) already exists",
				apiKey: "sk-live-abcdef1234567890",
			};
			createLogger({ job: "contract-test" }).error(
				"db error",
				undefined,
				postgrestLike,
			);

			const serialized = spy.mock.calls[0][0] as string;
			expect(serialized).not.toContain("sk-live-abcdef1234567890");
			expect(serialized).toContain("[REDACTED]");

			const parsed = JSON.parse(serialized);
			expect(parsed.error).toMatchObject({
				message: "duplicate key value violates unique constraint",
				raw: { code: "23505", apiKey: "[REDACTED]" },
			});
		} finally {
			spy.mockRestore();
		}
	});
});
