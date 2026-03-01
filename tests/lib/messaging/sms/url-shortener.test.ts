import { describe, expect, it, vi } from "vitest";
import {
	buildShortUrl,
	generateShortId,
	shortenUrl,
	shortenUrls,
} from "../../../../src/lib/messaging/sms/url-shortener";
import { expectConsoleWarning } from "../../../setup";

vi.mock("../../../../src/lib/db/env", () => ({
	getSiteUrl: () => "https://stocktextalerts.com",
}));

describe("generateShortId", () => {
	it("returns a 6-character string", () => {
		const id = generateShortId();
		expect(id).toHaveLength(6);
	});

	it("contains only base62 characters", () => {
		const id = generateShortId();
		expect(id).toMatch(/^[0-9A-Za-z]{6}$/);
	});

	it("produces unique IDs across multiple calls", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateShortId()));
		expect(ids.size).toBe(100);
	});
});

describe("buildShortUrl", () => {
	it("returns a full URL with the /r/ prefix", () => {
		expect(buildShortUrl("Ab12Cd")).toBe(
			"https://stocktextalerts.com/r/Ab12Cd",
		);
	});
});

describe("shortenUrl", () => {
	it("returns existing short URL on dedup hit", async () => {
		const mockSupabase = {
			from: () => ({
				select: () => ({
					eq: () => ({
						gt: () => ({
							limit: () => ({
								single: () =>
									Promise.resolve({ data: { id: "abc123" }, error: null }),
							}),
						}),
					}),
				}),
			}),
		};

		const result = await shortenUrl(
			"https://example.com/long",
			mockSupabase as never,
		);
		expect(result).toBe("https://stocktextalerts.com/r/abc123");
	});

	it("inserts and returns short URL on cache miss", async () => {
		const mockSupabase = {
			from: vi.fn().mockImplementation(() => ({
				select: () => ({
					eq: () => ({
						gt: () => ({
							limit: () => ({
								single: () => Promise.resolve({ data: null, error: null }),
							}),
						}),
					}),
				}),
				insert: () => Promise.resolve({ error: null }),
			})),
		};

		const result = await shortenUrl(
			"https://example.com/long",
			mockSupabase as never,
		);
		expect(result).toMatch(
			/^https:\/\/stocktextalerts\.com\/r\/[0-9A-Za-z]{6}$/,
		);
	});

	it("falls back to original URL on DB error", async () => {
		expectConsoleWarning("URL shortener insert failed");
		const mockSupabase = {
			from: () => ({
				select: () => ({
					eq: () => ({
						gt: () => ({
							limit: () => ({
								single: () =>
									Promise.resolve({
										data: null,
										error: { code: "PGRST116", message: "not found" },
									}),
							}),
						}),
					}),
				}),
				insert: () =>
					Promise.resolve({
						error: { code: "42501", message: "permission denied" },
					}),
			}),
		};

		const original = "https://example.com/long";
		const result = await shortenUrl(original, mockSupabase as never);
		expect(result).toBe(original);
	});
});

describe("shortenUrls", () => {
	it("returns a Map from original to short URLs", async () => {
		let callCount = 0;
		const mockSupabase = {
			from: () => ({
				select: () => ({
					eq: () => ({
						gt: () => ({
							limit: () => ({
								single: () =>
									Promise.resolve({
										data: { id: `id${++callCount}` },
										error: null,
									}),
							}),
						}),
					}),
				}),
			}),
		};

		const urls = [
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/a", // duplicate
		];
		const result = await shortenUrls(urls, mockSupabase as never);

		expect(result.size).toBe(2); // deduped
		expect(result.get("https://example.com/a")).toMatch(
			/stocktextalerts\.com\/r\//,
		);
		expect(result.get("https://example.com/b")).toMatch(
			/stocktextalerts\.com\/r\//,
		);
	});
});
