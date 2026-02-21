import { describe, expect, it } from "vitest";
import { isValidUuid } from "../../../src/lib/validation";

describe("isValidUuid security validation", () => {
	it("accepts valid UUID v4 format", () => {
		expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
		expect(isValidUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
		expect(isValidUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
		expect(isValidUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
		expect(isValidUuid("a1b2c3d4-e5f6-4789-abcd-ef0123456789")).toBe(true);
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
		expect(isValidUuid("../etc/passwd")).toBe(false);
	});

	it("rejects null, undefined, and empty", () => {
		expect(isValidUuid(null)).toBe(false);
		expect(isValidUuid(undefined)).toBe(false);
		expect(isValidUuid("")).toBe(false);
	});
});
