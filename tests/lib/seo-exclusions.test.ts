import { describe, expect, it } from "vitest";
import {
	EXCLUDED_ROUTE_PREFIXES,
	ROBOTS_ONLY_DISALLOW_PREFIXES,
} from "../../src/lib/seo/excluded-routes";
import { GET as getRobotsTxt } from "../../src/pages/robots.txt";

describe("SEO exclusion lists stay in sync.", () => {
	it("robots.txt output contains Disallow lines for all excluded prefixes.", async () => {
		const previousVercelUrl = process.env.VERCEL_URL;
		process.env.VERCEL_URL ??= "https://example.com";
		try {
			const response = await getRobotsTxt();
			const body = await response.text();

			const expectedDisallowLines = [
				...ROBOTS_ONLY_DISALLOW_PREFIXES,
				...EXCLUDED_ROUTE_PREFIXES,
			].map((prefix) => `Disallow: ${prefix}`);

			for (const line of expectedDisallowLines) {
				expect(body).toContain(line);
			}
		} finally {
			if (previousVercelUrl === undefined) {
				delete process.env.VERCEL_URL;
			} else {
				process.env.VERCEL_URL = previousVercelUrl;
			}
		}
	});

	it("No duplicate entries in EXCLUDED_ROUTE_PREFIXES.", () => {
		const set = new Set(EXCLUDED_ROUTE_PREFIXES);
		expect(set.size).toBe(EXCLUDED_ROUTE_PREFIXES.length);
	});

	it("All prefixes start with a forward slash.", () => {
		const allPrefixes = [...EXCLUDED_ROUTE_PREFIXES, ...ROBOTS_ONLY_DISALLOW_PREFIXES];
		for (const prefix of allPrefixes) {
			expect(prefix.startsWith("/")).toBe(true);
		}
	});
});
