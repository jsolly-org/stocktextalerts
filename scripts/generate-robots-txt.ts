#!/usr/bin/env tsx
/**
 * Generate robots.txt from the single source-of-truth SEO configuration.
 *
 * This ensures robots.txt stays in sync with sitemap exclusions.
 * Run this script when seo.ts changes, or add it as a pre-build step.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAllRobotsDisallowedRoutes } from "../src/config/seo";

const ROBOTS_TXT_PATH = join(
	import.meta.dirname,
	"..",
	"public",
	"robots.txt",
);

const SITE_URL = "https://www.stocktextalerts.com";

function generateRobotsTxt(): string {
	const disallowedRoutes = getAllRobotsDisallowedRoutes();

	const lines = [
		"User-agent: *",
		"Allow: /",
		// Add each disallowed route
		...disallowedRoutes.map((route) => `Disallow: ${route}`),
		"",
		`Sitemap: ${SITE_URL}/sitemap-index.xml`,
		"",
	];

	return lines.join("\n");
}

const content = generateRobotsTxt();
writeFileSync(ROBOTS_TXT_PATH, content, "utf-8");

console.log("✅ Generated robots.txt");
console.log(`   Location: ${ROBOTS_TXT_PATH}`);
console.log(
	`   Disallowed routes: ${getAllRobotsDisallowedRoutes().length}`,
);
