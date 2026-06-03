import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getApprovalAdminEmails,
	isApprovalAdminEmail,
	parseApprovalAdminEmails,
} from "../../../src/lib/auth/approval-admin";

describe("approval admin allowlist", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("parses comma-separated emails case-insensitively and trims whitespace.", () => {
		expect(parseApprovalAdminEmails(" test@jsolly.com, ADMIN@example.com ,, ")).toEqual(
			new Set(["test@jsolly.com", "admin@example.com"]),
		);
	});

	it("returns an empty set when the env value is missing or blank.", () => {
		expect(parseApprovalAdminEmails(undefined)).toEqual(new Set());
		expect(parseApprovalAdminEmails("   ")).toEqual(new Set());
	});

	it("recognizes test@jsolly.com when configured for local development.", () => {
		vi.stubEnv("APPROVAL_ADMIN_EMAILS", "test@jsolly.com");

		expect(getApprovalAdminEmails()).toEqual(new Set(["test@jsolly.com"]));
		expect(isApprovalAdminEmail("test@jsolly.com")).toBe(true);
	});

	it("rejects missing emails and emails not in the allowlist.", () => {
		vi.stubEnv("APPROVAL_ADMIN_EMAILS", "test@jsolly.com");

		expect(isApprovalAdminEmail(null)).toBe(false);
		expect(isApprovalAdminEmail(undefined)).toBe(false);
		expect(isApprovalAdminEmail("other@example.com")).toBe(false);
	});
});
