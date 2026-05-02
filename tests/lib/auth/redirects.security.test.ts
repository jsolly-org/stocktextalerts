import { describe, expect, it } from "vitest";
import { getSafeRedirectPath } from "../../../src/lib/auth/redirects";

describe("getSafeRedirectPath open-redirect protection", () => {
	it("accepts valid paths and returns trimmed value", () => {
		expect(getSafeRedirectPath("/dashboard")).toBe("/dashboard");
		expect(getSafeRedirectPath("/auth/signin?redirect=")).toBe("/auth/signin?redirect=");
		expect(getSafeRedirectPath("/")).toBe("/");
	});

	it("rejects protocol-relative and external URLs", () => {
		expect(getSafeRedirectPath("//evil.com")).toBeNull();
		expect(getSafeRedirectPath("javascript:alert(1)")).toBeNull();
		expect(getSafeRedirectPath("https://evil.com/path")).toBeNull();
	});

	it("rejects paths containing backslashes", () => {
		// String literal "/\\/evil.com" is path "/\/evil.com"; browsers may normalize \ to /
		// turning it into "//evil.com" (protocol-relative). The backslash check in redirects.ts blocks this.
		expect(getSafeRedirectPath("/\\/evil.com")).toBeNull();
	});

	it("rejects paths containing CRLF to prevent HTTP response splitting", () => {
		expect(getSafeRedirectPath("/foo\nEvil: bar")).toBeNull();
		expect(getSafeRedirectPath("/foo\r\nLocation: https://evil.com")).toBeNull();
		expect(getSafeRedirectPath("/dashboard\r")).toBeNull();
	});

	it("rejects null, empty string, and whitespace-only", () => {
		expect(getSafeRedirectPath(null)).toBeNull();
		expect(getSafeRedirectPath("")).toBeNull();
		expect(getSafeRedirectPath("   ")).toBeNull();
		expect(getSafeRedirectPath("\t\n")).toBeNull();
	});

	it("trims valid paths before returning", () => {
		expect(getSafeRedirectPath("  /dashboard  ")).toBe("/dashboard");
	});
});
