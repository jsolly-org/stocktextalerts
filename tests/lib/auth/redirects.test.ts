import { describe, expect, it } from "vitest";
import {
	appendHashIfMissing,
	buildClientReturnPath,
	buildSigninRedirectUrl,
	getPostSigninRedirect,
	getSafeRedirectPath,
	mergeLocationHashIntoRedirectValue,
} from "../../../src/lib/auth/redirects";

describe("getSafeRedirectPath open-redirect protection", () => {
	it("accepts valid paths and returns trimmed value", () => {
		expect(getSafeRedirectPath("/dashboard")).toBe("/dashboard");
		expect(getSafeRedirectPath("/auth/signin?redirect=")).toBe("/auth/signin?redirect=");
		expect(getSafeRedirectPath("/")).toBe("/");
	});

	it("accepts paths with query strings and hash fragments", () => {
		expect(getSafeRedirectPath("/dashboard#market-notifications")).toBe(
			"/dashboard#market-notifications",
		);
		expect(getSafeRedirectPath("/dashboard?tab=alerts")).toBe("/dashboard?tab=alerts");
		expect(getSafeRedirectPath("/dashboard?tab=alerts#market-notifications")).toBe(
			"/dashboard?tab=alerts#market-notifications",
		);
		expect(getSafeRedirectPath("/profile#account")).toBe("/profile#account");
		expect(getSafeRedirectPath("/admin/users?page=2#list")).toBe("/admin/users?page=2#list");
	});

	it("rejects protocol-relative and external URLs", () => {
		expect(getSafeRedirectPath("//evil.com")).toBeNull();
		expect(getSafeRedirectPath("javascript:alert(1)")).toBeNull();
		expect(getSafeRedirectPath("https://evil.com/path")).toBeNull();
		expect(getSafeRedirectPath("//evil.com#market-notifications")).toBeNull();
		expect(getSafeRedirectPath("https://evil.com/path#section")).toBeNull();
	});

	it("rejects paths containing backslashes", () => {
		// String literal "/\\/evil.com" is path "/\/evil.com"; browsers may normalize \ to /
		// turning it into "//evil.com" (protocol-relative). The backslash check in redirects.ts blocks this.
		expect(getSafeRedirectPath("/\\/evil.com")).toBeNull();
		expect(getSafeRedirectPath("/\\/evil.com#section")).toBeNull();
	});

	it("rejects paths containing CRLF to prevent HTTP response splitting", () => {
		expect(getSafeRedirectPath("/foo\nEvil: bar")).toBeNull();
		expect(getSafeRedirectPath("/foo\r\nLocation: https://evil.com")).toBeNull();
		expect(getSafeRedirectPath("/dashboard\r")).toBeNull();
		expect(getSafeRedirectPath("/dashboard#section\nX-Injected: 1")).toBeNull();
	});

	it("rejects null, empty string, and whitespace-only", () => {
		expect(getSafeRedirectPath(null)).toBeNull();
		expect(getSafeRedirectPath("")).toBeNull();
		expect(getSafeRedirectPath("   ")).toBeNull();
		expect(getSafeRedirectPath("\t\n")).toBeNull();
	});

	it("trims valid paths before returning", () => {
		expect(getSafeRedirectPath("  /dashboard  ")).toBe("/dashboard");
		expect(getSafeRedirectPath("  /dashboard#market-notifications  ")).toBe(
			"/dashboard#market-notifications",
		);
	});
});

describe("appendHashIfMissing", () => {
	it("appends a hash when the path has none", () => {
		expect(appendHashIfMissing("/dashboard", "#market-notifications")).toBe(
			"/dashboard#market-notifications",
		);
		expect(appendHashIfMissing("/dashboard", "market-notifications")).toBe(
			"/dashboard#market-notifications",
		);
		expect(appendHashIfMissing("/dashboard?tab=1", "#watchlist")).toBe(
			"/dashboard?tab=1#watchlist",
		);
	});

	it("leaves an existing hash alone", () => {
		expect(appendHashIfMissing("/dashboard#watchlist", "#market-notifications")).toBe(
			"/dashboard#watchlist",
		);
	});

	it("ignores empty or bare hashes", () => {
		expect(appendHashIfMissing("/dashboard", "")).toBe("/dashboard");
		expect(appendHashIfMissing("/dashboard", "#")).toBe("/dashboard");
		expect(appendHashIfMissing("/dashboard", "   ")).toBe("/dashboard");
	});
});

describe("mergeLocationHashIntoRedirectValue", () => {
	it("folds a preserved location hash into an existing redirect path", () => {
		expect(mergeLocationHashIntoRedirectValue("/dashboard", "#market-notifications")).toBe(
			"/dashboard#market-notifications",
		);
		expect(mergeLocationHashIntoRedirectValue("/dashboard?ref=email", "#daily-notifications")).toBe(
			"/dashboard?ref=email#daily-notifications",
		);
	});

	it("defaults to /dashboard when only a hash is present", () => {
		expect(mergeLocationHashIntoRedirectValue("", "#market-notifications")).toBe(
			"/dashboard#market-notifications",
		);
		expect(mergeLocationHashIntoRedirectValue("   ", "#watchlist")).toBe("/dashboard#watchlist");
	});

	it("does not invent a path when there is no hash", () => {
		expect(mergeLocationHashIntoRedirectValue("", "")).toBe("");
		expect(mergeLocationHashIntoRedirectValue("", "#")).toBe("");
		expect(mergeLocationHashIntoRedirectValue("/profile", "")).toBe("/profile");
	});

	it("keeps an existing redirect hash", () => {
		expect(
			mergeLocationHashIntoRedirectValue("/dashboard#watchlist", "#market-notifications"),
		).toBe("/dashboard#watchlist");
	});

	it("rejects unsafe merged targets", () => {
		expect(mergeLocationHashIntoRedirectValue("//evil.com", "#section")).toBe("");
	});
});

describe("buildSigninRedirectUrl and getPostSigninRedirect", () => {
	it("encodes hash fragments in the redirect query parameter", () => {
		const url = buildSigninRedirectUrl("/dashboard#market-notifications");
		expect(url).toBe("/auth/signin?redirect=%2Fdashboard%23market-notifications");
		const parsed = new URL(url, "http://internal");
		expect(parsed.searchParams.get("redirect")).toBe("/dashboard#market-notifications");
	});

	it("round-trips query + hash redirects", () => {
		const path = "/dashboard?src=telegram#market-notifications";
		const signinUrl = buildSigninRedirectUrl(path);
		const redirectParam = new URL(signinUrl, "http://internal").searchParams.get("redirect");
		expect(getPostSigninRedirect(redirectParam)).toBe(path);
	});

	it("falls back to the dashboard when redirect is missing or unsafe", () => {
		expect(getPostSigninRedirect(null)).toBe("/dashboard");
		expect(getPostSigninRedirect("//evil.com")).toBe("/dashboard");
		expect(getPostSigninRedirect("/profile#account")).toBe("/profile#account");
	});

	it("returns bare sign-in when the redirect path is unsafe", () => {
		expect(buildSigninRedirectUrl("//evil.com#x")).toBe("/auth/signin");
		expect(buildSigninRedirectUrl(null)).toBe("/auth/signin");
	});
});

describe("buildClientReturnPath", () => {
	it("includes pathname, search, and hash", () => {
		expect(
			buildClientReturnPath({
				pathname: "/dashboard",
				search: "?tab=alerts",
				hash: "#market-notifications",
			}),
		).toBe("/dashboard?tab=alerts#market-notifications");
		expect(
			buildClientReturnPath({
				pathname: "/dashboard",
				search: "",
				hash: "",
			}),
		).toBe("/dashboard");
	});
});
