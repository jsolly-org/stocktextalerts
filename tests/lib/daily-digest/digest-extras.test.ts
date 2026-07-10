import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildNewsContextForGrok,
	fetchDigestNewsForGrok,
} from "../../../src/lib/daily-digest/digest-extras";
import type { CompanyNewsItem } from "../../../src/lib/types";
import {
	isOptionalVendorUnavailable,
	recordOptionalVendorFailure,
} from "../../../src/lib/vendors/optional-vendors";
import { resetOptionalVendorCircuits } from "../../helpers/reset-optional-vendor-circuits";

describe("buildNewsContextForGrok formats provider headlines into a Grok context string.", () => {
	it("Builds context lines from multiple tickers with headlines.", () => {
		const newsData = new Map<string, CompanyNewsItem[]>([
			[
				"AAPL",
				[
					{
						headline: "Apple launches new MacBook",
						summary: "",
						datetime: 1,
						url: "https://example.com/apple-macbook",
						source: "TechCrunch",
					},
					{
						headline: "Apple revenue beats estimates",
						summary: "",
						datetime: 2,
						url: "https://example.com/apple-revenue",
						source: "Reuters",
					},
				],
			],
			[
				"MSFT",
				[
					{
						headline: "Microsoft expands AI offerings",
						summary: "",
						datetime: 3,
						url: "",
						source: "",
					},
				],
			],
		]);

		const context = buildNewsContextForGrok(newsData);

		expect(context).toContain(
			"AAPL: Apple launches new MacBook — https://example.com/apple-macbook",
		);
		expect(context).toContain(
			"AAPL: Apple revenue beats estimates — https://example.com/apple-revenue",
		);
		expect(context).toContain("MSFT: Microsoft expands AI offerings");
	});

	it("Does not append URL suffix when url is empty.", () => {
		const newsData = new Map<string, CompanyNewsItem[]>([
			[
				"GOOG",
				[
					{
						headline: "Google IO announced",
						summary: "",
						datetime: 4,
						url: "",
						source: "",
					},
				],
			],
		]);
		const context = buildNewsContextForGrok(newsData);
		expect(context).toBe("GOOG: Google IO announced");
	});

	it("Returns empty string when no news data is available.", () => {
		const newsData = new Map<string, CompanyNewsItem[]>([["AAPL", []]]);

		const context = buildNewsContextForGrok(newsData);

		expect(context).toBe("");
	});
});

describe("fetchDigestNewsForGrok company-news degradation", () => {
	afterEach(() => {
		resetOptionalVendorCircuits();
		vi.restoreAllMocks();
	});

	it("stops fetching news when company-news circuit is open", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		recordOptionalVendorFailure("company-news");
		recordOptionalVendorFailure("company-news");
		expect(isOptionalVendorUnavailable("company-news")).toBe(true);

		const result = await fetchDigestNewsForGrok(["AAPL", "MSFT"]);

		expect(result.size).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
