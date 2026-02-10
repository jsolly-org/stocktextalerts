import { describe, expect, it } from "vitest";
import {
	EXCLUDED_ROUTE_PREFIXES,
	ROBOTS_ONLY_DISALLOW_PREFIXES,
} from "../../src/lib/seo/excluded-routes";

describe("SEO exclusion lists stay in sync.", () => {
	it("robots.txt disallows are a superset of sitemap exclusions.", () => {
		const allRobotsDisallows = [
			...ROBOTS_ONLY_DISALLOW_PREFIXES,
			...EXCLUDED_ROUTE_PREFIXES,
		];

		for (const prefix of EXCLUDED_ROUTE_PREFIXES) {
			expect(allRobotsDisallows).toContain(prefix);
		}
	});

	it("No duplicate entries in EXCLUDED_ROUTE_PREFIXES.", () => {
		const set = new Set(EXCLUDED_ROUTE_PREFIXES);
		expect(set.size).toBe(EXCLUDED_ROUTE_PREFIXES.length);
	});

	it("All prefixes start with a forward slash.", () => {
		const allPrefixes = [
			...EXCLUDED_ROUTE_PREFIXES,
			...ROBOTS_ONLY_DISALLOW_PREFIXES,
		];
		for (const prefix of allPrefixes) {
			expect(prefix.startsWith("/")).toBe(true);
		}
	});
});
