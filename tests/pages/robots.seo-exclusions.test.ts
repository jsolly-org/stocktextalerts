import { describe, expect, it } from "vitest";
import {
	FULLY_BLOCKED_USER_AGENTS,
	isDisallowedInRobots,
	ROBOTS_DISALLOW_PREFIXES,
} from "../../seo-routes";
import { GET as getRobotsTxt } from "../../src/pages/robots.txt";
import { createApiContext } from "../helpers/api-context";

async function getRobotsBody(): Promise<string> {
	const response = await getRobotsTxt(
		createApiContext({ request: new Request("http://localhost/robots.txt") }),
	);
	return response.text();
}

describe("robots.txt reflects the private-app policy.", () => {
	it("emits Disallow lines for every general-crawl disallow prefix.", async () => {
		const body = await getRobotsBody();
		for (const prefix of ROBOTS_DISALLOW_PREFIXES) {
			expect(body).toContain(`Disallow: ${prefix}`);
		}
	});

	it("lets general crawlers fetch pages (so Googlebot sees the noindex header), never blanket-blocking them.", async () => {
		const body = await getRobotsBody();
		expect(body).toContain("User-agent: *\nAllow: /");
		// A bare `Disallow: /` in the wildcard group would hide the noindex directive
		// from Googlebot and defeat the de-index intent — that belongs only in the
		// per-scraper blocks below.
		const wildcardBlock = body.split("\n\n")[0] ?? "";
		expect(wildcardBlock.split("\n")).not.toContain("Disallow: /");
	});

	it("guards against emptied policy arrays (both must stay non-empty).", () => {
		expect(ROBOTS_DISALLOW_PREFIXES.length).toBeGreaterThan(0);
		expect(FULLY_BLOCKED_USER_AGENTS.length).toBeGreaterThan(0);
	});

	it("denies the whole site to every fully-blocked user-agent.", async () => {
		const body = await getRobotsBody();
		for (const agent of FULLY_BLOCKED_USER_AGENTS) {
			expect(body).toContain(`User-agent: ${agent}\nDisallow: /`);
		}
	});

	it("does not advertise a sitemap (the private app has none).", async () => {
		const body = await getRobotsBody();
		expect(body).not.toMatch(/^Sitemap:/m);
	});

	it("No duplicate entries in ROBOTS_DISALLOW_PREFIXES.", () => {
		const set = new Set(ROBOTS_DISALLOW_PREFIXES);
		expect(set.size).toBe(ROBOTS_DISALLOW_PREFIXES.length);
	});

	it("No duplicate entries in FULLY_BLOCKED_USER_AGENTS.", () => {
		const set = new Set(FULLY_BLOCKED_USER_AGENTS);
		expect(set.size).toBe(FULLY_BLOCKED_USER_AGENTS.length);
	});

	it("All robots disallow prefixes start with a forward slash.", () => {
		for (const prefix of ROBOTS_DISALLOW_PREFIXES) {
			expect(prefix.startsWith("/")).toBe(true);
		}
	});
});

describe("Private-route robots policy.", () => {
	it("disallows /admin, /api/, /dashboard, and /profile in robots.txt.", () => {
		expect(isDisallowedInRobots("/admin/users")).toBe(true);
		expect(isDisallowedInRobots("/api/auth/signin")).toBe(true);
		expect(isDisallowedInRobots("/dashboard")).toBe(true);
		expect(isDisallowedInRobots("/profile")).toBe(true);
	});

	it("does not disallow /auth/pending-approval in robots.txt.", () => {
		expect(isDisallowedInRobots("/auth/pending-approval")).toBe(false);
	});
});
