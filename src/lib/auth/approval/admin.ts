import { readEnv } from "../../db/env";

const ADMIN_EMAILS_ENV = "ADMIN_EMAILS";

export function parseAdminEmails(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email.length > 0),
	);
}

export function getAdminEmails(): Set<string> {
	return parseAdminEmails(readEnv(ADMIN_EMAILS_ENV));
}

export function isApprovalAdminEmail(email: string | null | undefined): boolean {
	if (!email) return false;
	return getAdminEmails().has(email.trim().toLowerCase());
}
