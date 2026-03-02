import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLogoCache,
	fetchLogoBase64,
	prefetchLogos,
	renderLogoImg,
} from "../../../src/lib/messaging/logo-fetcher";
import { expectConsoleWarning } from "../../setup";

describe("logo-fetcher", () => {
	beforeEach(() => {
		vi.stubEnv("MASSIVE_API_KEY", "test-api-key");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	describe("fetchLogoBase64", () => {
		it("Returns base64 data URI on success.", async () => {
			const pngBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
			const mockResponse = new Response(pngBytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

			const cache = createLogoCache();
			const result = await fetchLogoBase64(
				"AAPL",
				"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
				cache,
			);

			expect(result).toBe(
				`data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`,
			);
			expect(cache.get("AAPL")).toBe(result);
		});

		it("Returns null when iconUrl is null.", async () => {
			const cache = createLogoCache();
			const result = await fetchLogoBase64("AAPL", null, cache);

			expect(result).toBeNull();
			expect(cache.get("AAPL")).toBeNull();
		});

		it("Returns null when iconUrl is undefined.", async () => {
			const cache = createLogoCache();
			const result = await fetchLogoBase64("AAPL", undefined, cache);

			expect(result).toBeNull();
		});

		it("Returns null when host is not api.massive.com.", async () => {
			const cache = createLogoCache();
			const result = await fetchLogoBase64(
				"AAPL",
				"https://evil.example.com/icon.png",
				cache,
			);

			expect(result).toBeNull();
			expect(cache.get("AAPL")).toBeNull();
		});

		it("Returns null on fetch error.", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
				new Error("Network error"),
			);

			const cache = createLogoCache();
			expectConsoleWarning(/Failed to fetch logo/);
			const result = await fetchLogoBase64(
				"AAPL",
				"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
				cache,
			);

			expect(result).toBeNull();
			expect(cache.get("AAPL")).toBeNull();
		});

		it("Returns null on non-OK response.", async () => {
			const mockResponse = new Response("Not Found", { status: 404 });
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

			const cache = createLogoCache();
			const result = await fetchLogoBase64(
				"AAPL",
				"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
				cache,
			);

			expect(result).toBeNull();
		});

		it("Caches results (fetch called only once per symbol).", async () => {
			const pngBytes = new Uint8Array([137, 80, 78, 71]);
			const mockResponse = new Response(pngBytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(mockResponse);

			const cache = createLogoCache();
			const result1 = await fetchLogoBase64(
				"AAPL",
				"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
				cache,
			);
			const result2 = await fetchLogoBase64(
				"AAPL",
				"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
				cache,
			);

			expect(result1).toBe(result2);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it("Appends MASSIVE_API_KEY to the URL.", async () => {
			const pngBytes = new Uint8Array([137, 80, 78, 71]);
			const mockResponse = new Response(pngBytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(mockResponse);

			const cache = createLogoCache();
			await fetchLogoBase64(
				"AAPL",
				"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
				cache,
			);

			const fetchedUrl = fetchSpy.mock.calls[0][0] as string;
			expect(fetchedUrl).toContain("apiKey=test-api-key");
		});
	});

	describe("prefetchLogos", () => {
		it("Populates cache for multiple symbols.", async () => {
			const pngBytes = new Uint8Array([137, 80, 78, 71]);
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
				return new Response(pngBytes, {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			});

			const cache = createLogoCache();
			await prefetchLogos(
				[
					{
						symbol: "AAPL",
						icon_url:
							"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
					},
					{
						symbol: "MSFT",
						icon_url:
							"https://api.massive.com/v3/reference/tickers/MSFT/branding/icon.png",
					},
					{ symbol: "UNKNOWN", icon_url: null },
				],
				cache,
			);

			expect(cache.has("AAPL")).toBe(true);
			expect(cache.has("MSFT")).toBe(true);
			expect(cache.has("UNKNOWN")).toBe(true);
			expect(cache.get("AAPL")).toContain("data:image/png;base64,");
			expect(cache.get("MSFT")).toContain("data:image/png;base64,");
			expect(cache.get("UNKNOWN")).toBeNull();
		});

		it("Skips already-cached symbols.", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch");

			const cache = createLogoCache();
			cache.set("AAPL", "data:image/png;base64,cached");

			await prefetchLogos(
				[
					{
						symbol: "AAPL",
						icon_url:
							"https://api.massive.com/v3/reference/tickers/AAPL/branding/icon.png",
					},
				],
				cache,
			);

			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("renderLogoImg", () => {
		it("Produces correct img tag.", () => {
			const result = renderLogoImg("data:image/png;base64,abc123");
			expect(result).toBe(
				'<img src="data:image/png;base64,abc123" alt="" width="20" height="20" style="vertical-align: middle; border-radius: 4px; margin-right: 4px;" />',
			);
		});
	});
});
