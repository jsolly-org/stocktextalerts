#!/usr/bin/env tsx
/**
 * Standalone test to verify robots.txt and sitemap exclusions are in sync.
 *
 * This test does not require database setup and can be run independently.
 * Run with: npm run seo:test-sync
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAllRobotsDisallowedRoutes,
	seoExcludedRoutes,
} from "../src/config/seo";

const ROBOTS_TXT_PATH = join(
	import.meta.dirname,
	"..",
	"public",
	"robots.txt",
);

function parseRobotsTxtDisallows(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => line.startsWith("Disallow:"))
		.map((line) => line.replace("Disallow:", "").trim())
		.sort();
}

function testRobotsTxtContainsSitemapExclusions(): void {
	const robotsTxtContent = readFileSync(ROBOTS_TXT_PATH, "utf-8");
	const disallowedInRobotsTxt = parseRobotsTxtDisallows(robotsTxtContent);

	const failures: string[] = [];

	// Every route excluded from sitemap should be disallowed in robots.txt
	for (const route of seoExcludedRoutes) {
		if (!disallowedInRobotsTxt.includes(route)) {
			failures.push(
				`❌ Route ${route} is excluded from sitemap but NOT disallowed in robots.txt`,
			);
		}
	}

	if (failures.length > 0) {
		console.error("\n❌ Test failed: robots.txt missing sitemap exclusions");
		for (const failure of failures) {
			console.error(`   ${failure}`);
		}
		process.exit(1);
	}

	console.log(
		"✅ All sitemap exclusions are disallowed in robots.txt",
	);
}

function testRobotsTxtMatchesExpected(): void {
	const robotsTxtContent = readFileSync(ROBOTS_TXT_PATH, "utf-8");
	const actualDisallows = parseRobotsTxtDisallows(robotsTxtContent);
	const expectedDisallows = getAllRobotsDisallowedRoutes().slice().sort();

	const actualSet = new Set(actualDisallows);
	const expectedSet = new Set(expectedDisallows);

	const missing = expectedDisallows.filter((r) => !actualSet.has(r));
	const extra = actualDisallows.filter((r) => !expectedSet.has(r));

	if (missing.length > 0 || extra.length > 0) {
		console.error("\n❌ Test failed: robots.txt does not match expected");
		if (missing.length > 0) {
			console.error("   Missing routes:");
			for (const route of missing) {
				console.error(`     - ${route}`);
			}
		}
		if (extra.length > 0) {
			console.error("   Extra routes:");
			for (const route of extra) {
				console.error(`     - ${route}`);
			}
		}
		console.error(
			"\n   Fix: Run `npm run seo:generate-robots` to regenerate robots.txt",
		);
		process.exit(1);
	}

	console.log(
		`✅ robots.txt contains exactly ${expectedDisallows.length} expected disallowed routes`,
	);
}

function testGeneratedContentMatches(): void {
	const actualContent = readFileSync(ROBOTS_TXT_PATH, "utf-8");

	const expectedLines = [
		"User-agent: *",
		"Allow: /",
		...getAllRobotsDisallowedRoutes().map((route) => `Disallow: ${route}`),
		"",
		"Sitemap: https://www.stocktextalerts.com/sitemap-index.xml",
		"",
	];
	const expectedContent = expectedLines.join("\n");

	if (actualContent !== expectedContent) {
		console.error(
			"\n❌ Test failed: robots.txt does not match generated content",
		);
		console.error(
			"   This suggests robots.txt was manually edited instead of generated.",
		);
		console.error(
			"   Fix: Run `npm run seo:generate-robots` to regenerate robots.txt",
		);
		process.exit(1);
	}

	console.log("✅ robots.txt matches generated content (not manually edited)");
}

// Run all tests
console.log("\n🔍 Running SEO sync tests...\n");

testRobotsTxtContainsSitemapExclusions();
testRobotsTxtMatchesExpected();
testGeneratedContentMatches();

console.log("\n✅ All SEO sync tests passed!\n");
