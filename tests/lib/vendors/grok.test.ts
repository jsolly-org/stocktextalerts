/**
 * Grok client: non-retriable auth/credits failures must fail fast and short-circuit
 * later calls in the same process (nightly PM discovery multi-symbol path).
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { fetchGrokResponse, resetGrokAuthExhausted } from "../../../src/lib/vendors/grok";
import { expectConsoleError } from "../../setup";

describe("fetchGrokResponse auth short-circuit", () => {
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(() => {
		resetGrokAuthExhausted();
		vi.stubEnv("XAI_API_KEY", "test-key");
		// Spy after network-guard install so this double replaces the guard for the test.
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		resetGrokAuthExhausted();
	});

	it("a 403 credits rejection does not retry and skips subsequent calls", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "permission-denied",
					error: "monthly spending limit",
				}),
				{ status: 403, statusText: "Forbidden" },
			),
		);

		const first = await fetchGrokResponse({
			requestBody: {
				model: "grok-4",
				input: "hi",
				instructions: "test",
			},
			logContext: { action: "pm_alias_enrich", symbol: "AAON" },
		});
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const second = await fetchGrokResponse({
			requestBody: {
				model: "grok-4",
				input: "hi",
				instructions: "test",
			},
			logContext: { action: "pm_alias_enrich", symbol: "AMD" },
		});
		expect(second).toBeNull();
		// Process-local short-circuit: no second HTTP attempt.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("transient 5xx still retries before exhausting", async () => {
		expectConsoleError(/Grok request failed/);
		fetchSpy
			.mockResolvedValueOnce(new Response("upstream", { status: 502, statusText: "Bad Gateway" }))
			.mockResolvedValueOnce(new Response("upstream", { status: 502, statusText: "Bad Gateway" }))
			.mockResolvedValueOnce(new Response("upstream", { status: 502, statusText: "Bad Gateway" }));

		const result = await fetchGrokResponse({
			requestBody: {
				model: "grok-4",
				input: "hi",
				instructions: "test",
			},
			logContext: { action: "test" },
		});
		expect(result).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("a 400 validation error does not retry", async () => {
		expectConsoleError(/Grok request rejected \(400/);
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ error: "invalid schema" }), {
				status: 400,
				statusText: "Bad Request",
			}),
		);

		const result = await fetchGrokResponse({
			requestBody: {
				model: "grok-4",
				input: "hi",
				instructions: "test",
			},
			logContext: { action: "test" },
		});
		expect(result).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
