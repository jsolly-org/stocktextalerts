import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQuote } from "../../src/lib/providers/finnhub";

describe("fetchQuote", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("returns price and changePercent from Finnhub quote payload", async () => {
		vi.stubEnv("FINNHUB_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ c: 101.25, dp: 1.5, pc: 99.75 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const quote = await fetchQuote("AAPL");

		expect(quote).toEqual({ price: 101.25, changePercent: 1.5 });
	});

	it("computes changePercent from prev close when dp is unavailable", async () => {
		vi.stubEnv("FINNHUB_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ c: 110, pc: 100 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const quote = await fetchQuote("MSFT");

		expect(quote).toEqual({ price: 110, changePercent: 10 });
	});

	it("returns null when Finnhub quote has no usable price", async () => {
		vi.stubEnv("FINNHUB_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ c: 0, dp: 0, pc: 0 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const quote = await fetchQuote("SPIT");

		expect(quote).toBeNull();
	});
});
