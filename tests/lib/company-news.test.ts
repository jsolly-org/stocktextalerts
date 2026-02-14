import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCompanyNews } from "../../src/lib/providers/company-news";

describe("fetchCompanyNews", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("maps Massive fields to CompanyNewsItem shape", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: "Apple launches new MacBook",
							description: "A summary of the launch event.",
							published_utc: "2026-02-14T10:30:00Z",
							article_url: "https://example.com/apple-macbook",
							publisher: { name: "TechCrunch" },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const items = await fetchCompanyNews("AAPL", "2026-02-07", "2026-02-14");

		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			headline: "Apple launches new MacBook",
			summary: "A summary of the launch event.",
			datetime: Math.floor(Date.parse("2026-02-14T10:30:00Z") / 1000),
			url: "https://example.com/apple-macbook",
			source: "TechCrunch",
		});
	});

	it("converts ISO 8601 published_utc to unix seconds", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: "Test headline",
							published_utc: "2025-06-15T14:00:00Z",
							article_url: "",
							publisher: { name: "" },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const items = await fetchCompanyNews("MSFT", "2025-06-08", "2025-06-15");

		expect(items[0].datetime).toBe(
			Math.floor(Date.parse("2025-06-15T14:00:00Z") / 1000),
		);
	});

	it("returns empty array when response has no results", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const items = await fetchCompanyNews("GOOG", "2026-02-01", "2026-02-14");

		expect(items).toEqual([]);
	});

	it("returns empty array on malformed response", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ status: "ERROR" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const items = await fetchCompanyNews("TSLA", "2026-02-01", "2026-02-14");

		expect(items).toEqual([]);
	});

	it("filters out items missing required fields", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ title: "Good headline", published_utc: "2026-02-14T10:00:00Z" },
						{
							description: "No title field",
							published_utc: "2026-02-14T09:00:00Z",
						},
						{ title: "No date field" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const items = await fetchCompanyNews("NVDA", "2026-02-07", "2026-02-14");

		expect(items).toHaveLength(1);
		expect(items[0].headline).toBe("Good headline");
	});

	it("defaults optional fields when publisher/description/url are missing", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: "Bare minimum",
							published_utc: "2026-02-14T12:00:00Z",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const items = await fetchCompanyNews("META", "2026-02-07", "2026-02-14");

		expect(items[0]).toEqual({
			headline: "Bare minimum",
			summary: "",
			datetime: Math.floor(Date.parse("2026-02-14T12:00:00Z") / 1000),
			url: "",
			source: "",
		});
	});

	it("returns empty array on network error", async () => {
		vi.useFakeTimers();
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Network failure"),
		);

		const promise = fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14");
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toEqual([]);
	});

	it("returns empty array on non-200 response", async () => {
		vi.useFakeTimers();
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response(JSON.stringify({ error: "Rate limited" }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			});
		});

		const promise = fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14");
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toEqual([]);
	});

	it("filters out items with invalid published_utc", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ title: "Good headline", published_utc: "2026-02-14T10:00:00Z" },
						{ title: "Bad date", published_utc: "not-a-date" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const items = await fetchCompanyNews("NVDA", "2026-02-07", "2026-02-14");

		expect(items).toHaveLength(1);
		expect(items[0].headline).toBe("Good headline");
	});
});
