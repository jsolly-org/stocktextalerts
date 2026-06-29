import { describe, expect, it } from "vitest";
import {
	isDisallowedInRobots,
	isExcludedFromSitemap,
	ROBOTS_DISALLOW_PREFIXES,
	SITEMAP_EXCLUDED_ROUTE_PREFIXES,
} from "../../seo-routes";
import { GET as getRobotsTxt } from "../../src/pages/robots.txt";
import { createApiContext } from "../helpers/api-context";

describe("SEO exclusion lists stay in sync.", () => {
	it("robots.txt output contains Disallow lines for all robots disallow prefixes.", async () => {
		const previousProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
		process.env.VERCEL_PROJECT_PRODUCTION_URL = "https://www.stocktextalerts.com";
		try {
			const response = await getRobotsTxt(
				createApiContext({ request: new Request("http://localhost/robots.txt") }),
			);
			const body = await response.text();

			const expectedDisallowLines = ROBOTS_DISALLOW_PREFIXES.map((prefix) => `Disallow: ${prefix}`);

			for (const line of expectedDisallowLines) {
				expect(body).toContain(line);
			}
		} finally {
			if (previousProductionUrl === undefined) {
				delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
			} else {
				process.env.VERCEL_PROJECT_PRODUCTION_URL = previousProductionUrl;
			}
		}
	});

	it("robots.txt includes a sitemap-index.xml Sitemap line.", async () => {
		const response = await getRobotsTxt(
			createApiContext({ request: new Request("http://localhost/robots.txt") }),
		);
		const body = await response.text();

		expect(body).toMatch(/^Sitemap: .+\/sitemap-index\.xml$/m);
	});

	it("No duplicate entries in SITEMAP_EXCLUDED_ROUTE_PREFIXES.", () => {
		const set = new Set(SITEMAP_EXCLUDED_ROUTE_PREFIXES);
		expect(set.size).toBe(SITEMAP_EXCLUDED_ROUTE_PREFIXES.length);
	});

	it("No duplicate entries in ROBOTS_DISALLOW_PREFIXES.", () => {
		const set = new Set(ROBOTS_DISALLOW_PREFIXES);
		expect(set.size).toBe(ROBOTS_DISALLOW_PREFIXES.length);
	});

	it("All prefixes start with a forward slash.", () => {
		const allPrefixes = [...SITEMAP_EXCLUDED_ROUTE_PREFIXES, ...ROBOTS_DISALLOW_PREFIXES];
		for (const prefix of allPrefixes) {
			expect(prefix.startsWith("/")).toBe(true);
		}
	});
});

describe("Ahrefs audit private-route policy.", () => {
	it("excludes /auth/pending-approval and /admin from sitemap output.", () => {
		expect(isExcludedFromSitemap("/auth/pending-approval")).toBe(true);
		expect(isExcludedFromSitemap("/admin")).toBe(true);
		expect(isExcludedFromSitemap("/admin/users")).toBe(true);
	});

	it("disallows /admin, /api/, /dashboard, and /profile in robots.txt.", () => {
		expect(isDisallowedInRobots("/admin/users")).toBe(true);
		expect(isDisallowedInRobots("/api/auth/signin")).toBe(true);
		expect(isDisallowedInRobots("/dashboard")).toBe(true);
		expect(isDisallowedInRobots("/profile")).toBe(true);
	});

	it("does not disallow /auth/pending-approval in robots.txt.", () => {
		expect(isDisallowedInRobots("/auth/pending-approval")).toBe(false);
	});

	it("keeps public marketing pages in the sitemap.", () => {
		expect(isExcludedFromSitemap("/")).toBe(false);
		expect(isExcludedFromSitemap("/about")).toBe(false);
		expect(isExcludedFromSitemap("/terms")).toBe(false);
	});
});

/**
 * Issue-by-issue Ahrefs remediation matrix (2026-06 audit):
 * - Canonical points to redirect / 3XX redirect in sitemap: fix via PRODUCTION_SITE_URL=www.
 * - Noindex page / Noindex follow / Redirected page has no incoming internal links: pending-approval sitemap exclusion.
 * - 302 redirect / admin redirect chain: /admin sitemap + robots exclusion; auth redirect unchanged.
 * - Meta description too short: pending-approval description lengthened.
 * - HTTP to HTTPS redirect / redirect chain on http:// origins: accepted platform behavior.
 */
