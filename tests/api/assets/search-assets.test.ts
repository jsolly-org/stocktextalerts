import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as GETAssetSearch } from "../../../src/pages/api/assets/search";
import { createApiContext } from "../../helpers/api-context";
import { deleteAssets, upsertAssets } from "../../helpers/asset-db";
import { TEST_PASSWORD } from "../../helpers/constants";
import { createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

async function searchAssets(
	query: string,
	cookies: Map<string, string>,
	limit = 10,
): Promise<Response> {
	const request = new Request(
		`http://localhost/api/assets/search?q=${encodeURIComponent(query)}&limit=${limit}`,
		{ method: "GET" },
	);

	return GETAssetSearch(
		createApiContext({
			request,
			cookies,
		}),
	);
}

describe("Asset search ranking", () => {
	it("returns exact symbol matches before name-only matches", async () => {
		const testUser = await createTestUser({
			email: `test-search-exact-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const seedAssets = [
			{ symbol: "ZA100", name: "ZXQ10 Growth Basket", type: "etf" },
			{ symbol: "ZXQ10", name: "ZXQ10 Incorporated", type: "stock" },
		];

		try {
			await upsertAssets(seedAssets);

			const response = await searchAssets("ZXQ10", cookies);
			expect(response.status).toBe(200);

			const payload = await response.json();
			expect(payload.ok).toBe(true);
			expect(payload.results[0].symbol).toBe("ZXQ10");
		} finally {
			await deleteAssets(seedAssets.map((asset) => asset.symbol));
		}
	});

	it("returns symbol-prefix matches before name-only matches", async () => {
		const testUser = await createTestUser({
			email: `test-search-prefix-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const seedAssets = [
			{ symbol: "AA200", name: "QRT Sector Leaders", type: "etf" },
			{ symbol: "QRTZ", name: "QRTZ Systems", type: "stock" },
		];

		try {
			await upsertAssets(seedAssets);

			const response = await searchAssets("QRT", cookies);
			expect(response.status).toBe(200);

			const payload = await response.json();
			expect(payload.ok).toBe(true);
			expect(payload.results[0].symbol).toBe("QRTZ");
		} finally {
			await deleteAssets(seedAssets.map((asset) => asset.symbol));
		}
	});
});
