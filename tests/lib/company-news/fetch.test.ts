import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCompanyNews } from "../../../src/lib/company-news/fetch";
import {
	isOptionalVendorUnavailable,
	recordOptionalVendorFailure,
} from "../../../src/lib/vendors/optional-vendors";
import { resetOptionalVendorCircuits } from "../../helpers/reset-optional-vendor-circuits";
import { warnMessages } from "../../setup";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function massiveNewsResponse(results: unknown, status = 200): Response {
	return new Response(JSON.stringify({ results }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function newsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: "Apple launches new MacBook",
		description: "A summary of the launch event.",
		published_utc: "2026-02-14T09:00:00Z",
		article_url: "https://example.com/apple-macbook",
		publisher: { name: "TechCrunch" },
		tickers: ["AAPL"],
		...overrides,
	};
}

describe("fetchCompanyNews", () => {
	beforeEach(() => {
		vi.stubEnv("MASSIVE_API_KEY", "test-massive-key");
	});

	afterEach(() => {
		resetOptionalVendorCircuits();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("returns empty without fetching when the optional company-news circuit is open", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		recordOptionalVendorFailure("company-news");
		recordOptionalVendorFailure("company-news");

		await expect(fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14")).resolves.toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("requests Massive company news and maps its fields", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(massiveNewsResponse([newsRow()]));

		const items = await fetchCompanyNews("AAPL", "2026-02-07", "2026-02-14");

		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://api.massive.com/v2/reference/news?ticker=AAPL&published_utc.gte=2026-02-07T00%3A00%3A00Z&published_utc.lte=2026-02-14T23%3A59%3A59Z&limit=10&sort=published_utc&order=desc&apiKey=test-massive-key",
		);
		expect(items).toEqual([
			{
				headline: "Apple launches new MacBook",
				summary: "A summary of the launch event.",
				datetime: 1771059600,
				url: "https://example.com/apple-macbook",
				source: "TechCrunch",
				tickers: ["AAPL"],
			},
		]);
	});

	it("filters generic roundup articles tagged with more than five tickers", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			massiveNewsResponse([
				newsRow({ title: "Focused article", tickers: ["AAPL", "MSFT"] }),
				newsRow({
					title: "Ten stocks to buy now",
					tickers: ["AAPL", "MSFT", "GOOG", "META", "AMZN", "NVDA"],
				}),
			]),
		);

		const items = await fetchCompanyNews("AAPL", "2026-02-07", "2026-02-14");

		expect(items.map((item) => item.headline)).toEqual(["Focused article"]);
	});

	it("returns empty when Massive returns no articles without opening the circuit", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(massiveNewsResponse([]));

		await expect(fetchCompanyNews("GOOG", "2026-02-01", "2026-02-14")).resolves.toEqual([]);
		expect(isOptionalVendorUnavailable("company-news")).toBe(false);
	});

	it("throws on unexpected payload shape so digest budget can open the circuit", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ status: "OK" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(fetchCompanyNews("TSLA", "2026-02-01", "2026-02-14")).rejects.toThrow(
			/unexpected payload/,
		);
		// Circuit ownership lives in withOptionalVendorBudget — a bare fetch does not trip it.
		expect(isOptionalVendorUnavailable("company-news")).toBe(false);
	});

	it("filters rows missing a title or parseable publication timestamp", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			massiveNewsResponse([
				newsRow({ title: "Good headline" }),
				newsRow({ title: "" }),
				newsRow({ title: undefined }),
				newsRow({ published_utc: "not-a-date" }),
				newsRow({ published_utc: undefined }),
				"not-a-record",
			]),
		);

		const items = await fetchCompanyNews("NVDA", "2026-02-07", "2026-02-14");

		expect(items.map((item) => item.headline)).toEqual(["Good headline"]);
	});

	it("defaults optional fields and ticker tags to empty values", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			massiveNewsResponse([
				{
					title: "Bare minimum",
					published_utc: "2026-02-14T12:00:00Z",
				},
			]),
		);

		const items = await fetchCompanyNews("META", "2026-02-07", "2026-02-14");

		expect(items[0]).toEqual({
			headline: "Bare minimum",
			summary: "",
			datetime: 1771070400,
			url: "",
			source: "",
			tickers: [],
		});
	});

	it("returns at most ten articles", async () => {
		const articles = Array.from({ length: 14 }, (_, index) =>
			newsRow({
				title: `Article ${index + 1}`,
				published_utc: new Date(Date.UTC(2026, 1, 14, 12 - index)).toISOString(),
			}),
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(massiveNewsResponse(articles));

		const items = await fetchCompanyNews("AMZN", "2026-02-07", "2026-02-14");

		expect(items).toHaveLength(10);
		expect(items[0]?.headline).toBe("Article 1");
		expect(items[9]?.headline).toBe("Article 10");
	});

	it("throws after transport exhaustion so digest budget can open the circuit", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network failure"));

		await expect(fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14")).rejects.toThrow(
			/unexpected payload/,
		);
		expect(warnMessages()).toContainEqual(expect.stringContaining("exhausted retries"));
	});

	it("throws after a non-200 response so digest budget can open the circuit", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ status: "ERROR" }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14")).rejects.toThrow(
			/unexpected payload/,
		);
		expect(warnMessages()).toContainEqual(expect.stringContaining("exhausted retries"));
	});
});
