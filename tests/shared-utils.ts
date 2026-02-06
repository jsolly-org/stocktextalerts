import { randomInt } from "node:crypto";

/* ============= Request helpers ============= */
export { buildSmsInboundRequest, toRedirect } from "./request-helpers";

export function generateUniquePhoneNumber(): string {
	const suffix = randomInt(1_000_000, 9_999_999);
	return `555${String(suffix)}`;
}

/* ============= Stock data ============= */
export { getRealStockSymbols, getStockData } from "./stock-data";
/* ============= Test user & env ============= */
export { adminClient, createAuthenticatedCookies } from "./test-env";
export { cleanupTestUser, createTestEmail, createTestUser } from "./test-user";
export { registerTestUserForCleanup } from "./test-user-cleanup";
