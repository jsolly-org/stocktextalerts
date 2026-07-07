import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCompanyNews } from "../../../src/lib/company-news/fetch";
import {
	isOptionalVendorUnavailable,
	recordOptionalVendorFailure,
} from "../../../src/lib/vendors/optional-vendors";
import { resetOptionalVendorCircuits } from "../../helpers/reset-optional-vendor-circuits";

// Mock retry delays so error/retry tests don't wait real seconds
vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

/** Build a Finnhub /company-news JSON array response (Finnhub returns a bare array). */
function finnhubResponse(items: unknown[]): Response {
	return new Response(JSON.stringify(items), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("fetchCompanyNews", () => {
	beforeEach(() => {
		vi.stubEnv("FINNHUB_API_KEY", "test-finnhub-key");
	});

	afterEach(() => {
		resetOptionalVendorCircuits();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("returns empty array without calling fetch when circuit is open", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		recordOptionalVendorFailure("company-news");
		recordOptionalVendorFailure("company-news");

		const items = await fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14");

		expect(items).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("requests the Finnhub company-news endpoint and maps fields to CompanyNewsItem", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			finnhubResponse([
				{
					headline: "Apple launches new MacBook",
					summary: "A summary of the launch event.",
					datetime: 1771064400,
					url: "https://example.com/apple-macbook",
					source: "TechCrunch",
					category: "company",
					id: 7412160,
					image: "https://example.com/apple-macbook.jpg",
					related: "AAPL",
				},
			]),
		);

		const items = await fetchCompanyNews("AAPL", "2026-02-07", "2026-02-14");

		const fetchedUrl = String(fetchSpy.mock.calls[0]?.[0]);
		expect(fetchedUrl).toBe(
			"https://finnhub.io/api/v1/company-news?symbol=AAPL&from=2026-02-07&to=2026-02-14&token=test-finnhub-key",
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			headline: "Apple launches new MacBook",
			summary: "A summary of the launch event.",
			datetime: 1771064400,
			url: "https://example.com/apple-macbook",
			source: "TechCrunch",
		});
	});

	it("floors a fractional datetime to whole unix seconds", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			finnhubResponse([
				{
					headline: "Microsoft expands AI offerings",
					datetime: 1750000000.75,
				},
			]),
		);

		const items = await fetchCompanyNews("MSFT", "2025-06-08", "2025-06-15");

		expect(items[0]?.datetime).toBe(1750000000);
	});

	it("returns empty array when Finnhub returns no articles", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(finnhubResponse([]));

		const items = await fetchCompanyNews("GOOG", "2026-02-01", "2026-02-14");

		expect(items).toEqual([]);
		expect(isOptionalVendorUnavailable("company-news")).toBe(false);
	});

	it("records a vendor failure when the payload is not an array", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response(JSON.stringify({ error: "unexpected shape" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(fetchCompanyNews("TSLA", "2026-02-01", "2026-02-14")).resolves.toEqual([]);
		expect(isOptionalVendorUnavailable("company-news")).toBe(false);

		await expect(fetchCompanyNews("TSLA", "2026-02-01", "2026-02-14")).resolves.toEqual([]);
		expect(isOptionalVendorUnavailable("company-news")).toBe(true);
	});

	it("filters out items missing a headline or a datetime", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			finnhubResponse([
				{ headline: "Good headline", datetime: 1771059600 },
				{ summary: "No headline field", datetime: 1771056000 },
				{ headline: "", datetime: 1771052400 },
				{ headline: "No datetime field" },
				{ headline: "String datetime", datetime: "2026-02-14T10:00:00Z" },
				"not-a-record",
			]),
		);

		const items = await fetchCompanyNews("NVDA", "2026-02-07", "2026-02-14");

		expect(items).toHaveLength(1);
		expect(items[0]?.headline).toBe("Good headline");
	});

	it("defaults summary/url/source to empty strings when missing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			finnhubResponse([
				{
					headline: "Bare minimum",
					datetime: 1771070400,
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
		});
	});

	it("returns at most 10 articles", async () => {
		const articles = Array.from({ length: 14 }, (_, i) => ({
			headline: `Article ${i + 1}`,
			datetime: 1771064400 - i * 3600,
		}));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(finnhubResponse(articles));

		const items = await fetchCompanyNews("AMZN", "2026-02-07", "2026-02-14");

		expect(items).toHaveLength(10);
		expect(items[0]?.headline).toBe("Article 1");
		expect(items[9]?.headline).toBe("Article 10");
	});

	it("returns empty array on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network failure"));

		await expect(fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14")).resolves.toEqual([]);
	});

	it("returns empty array on non-200 response", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response(JSON.stringify({ error: "Rate limited" }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(fetchCompanyNews("AAPL", "2026-02-01", "2026-02-14")).resolves.toEqual([]);
	});
});
