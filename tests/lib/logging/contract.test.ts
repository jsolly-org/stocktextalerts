import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/lib/logging";
import { runWithRequestContext } from "../../../src/lib/logging/request-context";

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

			const [first] = spy.mock.calls[0] ?? [];
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
			createLogger({ job: "contract-test" }).error("db error", undefined, postgrestLike);

			const serialized = spy.mock.calls[0]![0] as string;
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

	it("vendor retry exhaustion includes category and top-level error for alert-hub", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			createLogger({ category: "schedule" }).error(
				"Finnhub insider-transactions exhausted retries",
				{ category: "vendor_retry_exhausted", reason: "timeout" },
				new Error("The operation was aborted due to timeout"),
			);
			const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
			expect(parsed.message).toBe("Finnhub insider-transactions exhausted retries");
			expect(parsed.context).toMatchObject({ category: "vendor_retry_exhausted" });
			expect(parsed.error).toMatchObject({
				name: "Error",
				message: "The operation was aborted due to timeout",
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("schema failures surface readable error.message for alert-hub", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			createLogger({ action: "load_insider_transactions" }).error(
				"Failed to load asset_insider_transactions",
				{ action: "load_insider_transactions" },
				new Error("Could not find the table 'public.asset_insider_transactions'"),
			);
			const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
			expect(parsed.message).toBe("Failed to load asset_insider_transactions");
			expect(parsed.error.message).toContain("Could not find the table");
		} finally {
			spy.mockRestore();
		}
	});

	it("passes Postgrest-like errors as the third argument for alert-hub", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const postgrestLike = {
				message: "Could not find the table 'public.asset_insider_transactions'",
				code: "PGRST205",
			};
			createLogger({ action: "load_finnhub_enrichment" }).error(
				"Failed to load asset_insider_transactions",
				{ action: "load_finnhub_enrichment" },
				postgrestLike,
			);
			const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
			expect(parsed.message).toBe("Failed to load asset_insider_transactions");
			expect(parsed.error.message).toContain("Could not find the table");
			expect(parsed.context?.error).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});

	it("propagates awsRequestId through runWithRequestContext", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const log = createLogger({ job: "contract-test" });
			const requestId = "326a1f6e-8038-45c4-af6d-459c24280033";
			await runWithRequestContext(requestId, async () => {
				log.error("downstream failed", undefined, new Error("upstream 500"));
				await Promise.resolve();
				log.error("retry exhausted", undefined, new Error("giving up"));
			});
			const calls = spy.mock.calls.map(([chunk]) => JSON.parse(chunk as string));
			expect(calls).toHaveLength(2);
			expect(calls[0]?.requestId).toBe(requestId);
			expect(calls[1]?.requestId).toBe(requestId);
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects context.error-only shape for alert-hub (must use third argument)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			createLogger({ action: "load_insider_transactions" }).error(
				"Failed to load asset_insider_transactions",
				{ action: "load_insider_transactions" },
				new Error("Could not find the table 'public.asset_insider_transactions'"),
			);
			const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
			expect(parsed.context?.error).toBeUndefined();
			expect(parsed.error.message).toContain("Could not find the table");
		} finally {
			spy.mockRestore();
		}
	});
});
