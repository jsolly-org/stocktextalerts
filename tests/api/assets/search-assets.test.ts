import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as GETAssetSearch } from "../../../src/pages/api/assets/search";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
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
			email: `test-search-exact-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const seedAssets = [
			{ symbol: "ZA100", name: "ZXQ10 Growth Basket", type: "etf" },
			{ symbol: "ZXQ10", name: "ZXQ10 Incorporated", type: "stock" },
		];

		try {
			const { error: seedError } = await adminClient
				.from("assets")
				.upsert(seedAssets, { onConflict: "symbol" });
			expect(seedError).toBeNull();

			const response = await searchAssets("ZXQ10", cookies);
			expect(response.status).toBe(200);

			const payload = await response.json();
			expect(payload.ok).toBe(true);
			expect(payload.results[0].symbol).toBe("ZXQ10");
		} finally {
			const { error: cleanupError } = await adminClient
				.from("assets")
				.delete()
				.in(
					"symbol",
					seedAssets.map((asset) => asset.symbol),
				);
			expect(cleanupError).toBeNull();
		}
	});

	it("returns symbol-prefix matches before name-only matches", async () => {
		const testUser = await createTestUser({
			email: `test-search-prefix-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const seedAssets = [
			{ symbol: "AA200", name: "QRT Sector Leaders", type: "etf" },
			{ symbol: "QRTZ", name: "QRTZ Systems", type: "stock" },
		];

		try {
			const { error: seedError } = await adminClient
				.from("assets")
				.upsert(seedAssets, { onConflict: "symbol" });
			expect(seedError).toBeNull();

			const response = await searchAssets("QRT", cookies);
			expect(response.status).toBe(200);

			const payload = await response.json();
			expect(payload.ok).toBe(true);
			expect(payload.results[0].symbol).toBe("QRTZ");
		} finally {
			const { error: cleanupError } = await adminClient
				.from("assets")
				.delete()
				.in(
					"symbol",
					seedAssets.map((asset) => asset.symbol),
				);
			expect(cleanupError).toBeNull();
		}
	});
});
