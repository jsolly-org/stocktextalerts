import { readEnv } from "../db/env";

const APPROVAL_ADMIN_EMAILS_ENV = "APPROVAL_ADMIN_EMAILS";

export function parseApprovalAdminEmails(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email.length > 0),
	);
}

export function getApprovalAdminEmails(): Set<string> {
	return parseApprovalAdminEmails(readEnv(APPROVAL_ADMIN_EMAILS_ENV));
}

export function isApprovalAdminEmail(email: string | null | undefined): boolean {
	if (!email) return false;
	return getApprovalAdminEmails().has(email.trim().toLowerCase());
}
