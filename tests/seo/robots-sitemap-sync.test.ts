import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getAllRobotsDisallowedRoutes,
	seoExcludedRoutes,
} from "../../src/config/seo";

describe("SEO: robots.txt and sitemap exclusions stay in sync", () => {
	it("robots.txt disallows all routes excluded from sitemap", () => {
		const robotsTxtPath = join(import.meta.dirname, "../../public/robots.txt");
		const robotsTxtContent = readFileSync(robotsTxtPath, "utf-8");

		// Parse disallowed routes from robots.txt
		const disallowedInRobotsTxt = robotsTxtContent
			.split("\n")
			.filter((line) => line.startsWith("Disallow:"))
			.map((line) => line.replace("Disallow:", "").trim());

		// Every route excluded from sitemap should be disallowed in robots.txt
		for (const route of seoExcludedRoutes) {
			expect(
				disallowedInRobotsTxt,
				`robots.txt should disallow ${route} (excluded from sitemap)`,
			).toContain(route);
		}
	});

	it("robots.txt contains exactly the expected disallowed routes", () => {
		const robotsTxtPath = join(import.meta.dirname, "../../public/robots.txt");
		const robotsTxtContent = readFileSync(robotsTxtPath, "utf-8");

		// Parse disallowed routes from robots.txt
		const disallowedInRobotsTxt = robotsTxtContent
			.split("\n")
			.filter((line) => line.startsWith("Disallow:"))
			.map((line) => line.replace("Disallow:", "").trim())
			.sort();

		// Get expected routes from config
		const expectedDisallowedRoutes = getAllRobotsDisallowedRoutes()
			.slice()
			.sort();

		// robots.txt should match exactly
		expect(disallowedInRobotsTxt).toEqual(expectedDisallowedRoutes);
	});

	it("robots.txt is generated from the single source-of-truth", () => {
		// This test ensures that the robots.txt file isn't manually edited
		// by verifying it matches what the generation script would produce
		const robotsTxtPath = join(import.meta.dirname, "../../public/robots.txt");
		const actualContent = readFileSync(robotsTxtPath, "utf-8");

		// Expected structure based on the generation script
		const expectedLines = [
			"User-agent: *",
			"Allow: /",
			...getAllRobotsDisallowedRoutes().map((route) => `Disallow: ${route}`),
			"",
			"Sitemap: https://www.stocktextalerts.com/sitemap-index.xml",
			"",
		];
		const expectedContent = expectedLines.join("\n");

		expect(actualContent).toBe(expectedContent);
	});
});
