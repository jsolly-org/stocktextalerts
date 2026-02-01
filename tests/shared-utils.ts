import { randomInt } from "node:crypto";

/* ============= Request helpers ============= */
export { buildSmsInboundRequest, toRedirect } from "./request-helpers";

export function generateUniquePhoneNumber(): string {
	const suffix = randomInt(1_000_000, 9_999_999);
	return `555${String(suffix)}`;
}

/* ============= Stock data ============= */
export {
	getRealStockSymbols,
	getStockData,
	type StockData,
} from "./stock-data";
/* ============= Test user & env ============= */
export {
	adminClient,
	createAuthenticatedCookies,
} from "./test-env";
export {
	type CreateTestUserOptions,
	cleanupTestUser,
	createTestEmail,
	createTestUser,
	type TestUser,
} from "./test-user";
