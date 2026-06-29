import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAdminEmails,
	isApprovalAdminEmail,
	parseAdminEmails,
} from "../../../../src/lib/auth/approval/admin";

describe("approval admin allowlist", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("parses comma-separated emails case-insensitively and trims whitespace.", () => {
		expect(parseAdminEmails(" test@jsolly.com, ADMIN@example.com ,, ")).toEqual(
			new Set(["test@jsolly.com", "admin@example.com"]),
		);
	});

	it("returns an empty set when the env value is missing or blank.", () => {
		expect(parseAdminEmails(undefined)).toEqual(new Set());
		expect(parseAdminEmails("   ")).toEqual(new Set());
	});

	it("recognizes test@jsolly.com when configured for local development.", () => {
		vi.stubEnv("ADMIN_EMAILS", "test@jsolly.com");

		expect(getAdminEmails()).toEqual(new Set(["test@jsolly.com"]));
		expect(isApprovalAdminEmail("test@jsolly.com")).toBe(true);
	});

	it("rejects missing emails and emails not in the allowlist.", () => {
		vi.stubEnv("ADMIN_EMAILS", "test@jsolly.com");

		expect(isApprovalAdminEmail(null)).toBe(false);
		expect(isApprovalAdminEmail(undefined)).toBe(false);
		expect(isApprovalAdminEmail("other@example.com")).toBe(false);
	});
});
