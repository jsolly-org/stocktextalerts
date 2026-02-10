#!/usr/bin/env tsx
/**
 * Generate robots.txt from the single source-of-truth SEO configuration.
 *
 * This ensures robots.txt stays in sync with sitemap exclusions.
 * Run this script when seo.ts changes, or add it as a pre-build step.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	generateRobotsTxtContent,
	getAllRobotsDisallowedRoutes,
} from "../src/config/seo";

const ROBOTS_TXT_PATH = join(
	import.meta.dirname,
	"..",
	"public",
	"robots.txt",
);

const content = generateRobotsTxtContent();
writeFileSync(ROBOTS_TXT_PATH, content, "utf-8");

console.log("✅ Generated robots.txt");
console.log(`   Location: ${ROBOTS_TXT_PATH}`);
console.log(
	`   Disallowed routes: ${getAllRobotsDisallowedRoutes().length}`,
);
