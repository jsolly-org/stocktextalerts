import { describe, expect, it } from "vitest";
import { isSafeRedirectUrl, isValidUuid } from "../../src/lib/validation";

describe("isValidUuid security validation", () => {
	it("accepts valid RFC 4122 UUID format", () => {
		expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
		expect(isValidUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
		expect(isValidUuid("a1b2c3d4-e5f6-4789-abcd-ef0123456789")).toBe(true);
	});

	it("rejects non-RFC 4122 UUIDs (nil and max)", () => {
		expect(isValidUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
		expect(isValidUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(false);
	});

	it("rejects malformed or non-UUID strings", () => {
		expect(isValidUuid("123")).toBe(false);
		expect(isValidUuid("not-a-uuid")).toBe(false);
		expect(isValidUuid("550e8400-e29b-41d4-a716")).toBe(false);
		expect(isValidUuid("550e8400e29b41d4a716446655440000")).toBe(false);
		expect(isValidUuid("550e8400-e29b-41d4-a716-44665544000g")).toBe(false);
	});

	it("rejects SQL injection attempts", () => {
		expect(isValidUuid("'; DROP TABLE users; --")).toBe(false);
		expect(isValidUuid("1' OR '1'='1")).toBe(false);
	});

	it("rejects path traversal attempts", () => {
		expect(isValidUuid("../etc/passwd")).toBe(false);
	});

	it("rejects null, undefined, and empty", () => {
		expect(isValidUuid(null)).toBe(false);
		expect(isValidUuid(undefined)).toBe(false);
		expect(isValidUuid("")).toBe(false);
	});

	it("rejects UUIDs with surrounding whitespace or braces", () => {
		expect(isValidUuid(" 550e8400-e29b-41d4-a716-446655440000")).toBe(false);
		expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000 ")).toBe(false);
		expect(isValidUuid("{550e8400-e29b-41d4-a716-446655440000}")).toBe(false);
	});
});

describe("isSafeRedirectUrl", () => {
	it("accepts http and https URLs", () => {
		expect(isSafeRedirectUrl("https://example.com/path")).toBe(true);
		expect(isSafeRedirectUrl("http://example.com")).toBe(true);
		expect(isSafeRedirectUrl("  https://a.co  ")).toBe(true);
	});

	it("rejects javascript:, data:, vbscript:, file:", () => {
		expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
		expect(isSafeRedirectUrl("JavaScript:void(0)")).toBe(false);
		expect(isSafeRedirectUrl("data:text/html,<script>")).toBe(false);
		expect(isSafeRedirectUrl("vbscript:msgbox(1)")).toBe(false);
		expect(isSafeRedirectUrl("file:///etc/passwd")).toBe(false);
	});

	it("rejects URLs containing CR or LF (response splitting)", () => {
		expect(isSafeRedirectUrl("https://example.com\r\nX-Injected: true")).toBe(
			false,
		);
		expect(isSafeRedirectUrl("https://example.com\n")).toBe(false);
		expect(isSafeRedirectUrl("https://example.com\r")).toBe(false);
	});

	it("rejects null, undefined, and empty", () => {
		expect(isSafeRedirectUrl(null)).toBe(false);
		expect(isSafeRedirectUrl(undefined)).toBe(false);
		expect(isSafeRedirectUrl("")).toBe(false);
		expect(isSafeRedirectUrl("   ")).toBe(false);
	});
});
