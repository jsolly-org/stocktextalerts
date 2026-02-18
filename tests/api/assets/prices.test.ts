import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getAssetPrices } from "../../../src/pages/api/assets/prices";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user loads onboarding asset price examples.", () => {
	it("Returns prev-close and sector data for tracked assets.", async () => {
		const testUser = await createTestUser({
			email: `asset-prices-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			trackedAssets: ["AAPL", "MSFT"],
		});
		registerTestUserForCleanup(testUser.id);

		// Seed known sectors so this test does not depend on external provider backfill.
		const { error: sectorSeedError } = await adminClient
			.from("assets")
			.update({ sector: "Technology" })
			.in("symbol", ["AAPL", "MSFT"]);
		expect(sectorSeedError).toBeNull();

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const response = await getAssetPrices(
			createApiContext({
				request: new Request("http://localhost/api/assets/prices", {
					method: "GET",
				}),
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			assets: Record<
				string,
				{
					prevClose: number | null;
					sector: string | null;
				}
			>;
		};
		expect(payload.ok).toBe(true);
		expect(payload.assets.AAPL).toBeDefined();
		expect(payload.assets.MSFT).toBeDefined();
		expect(typeof payload.assets.AAPL?.prevClose).toBe("number");
		expect(payload.assets.AAPL?.sector).toBe("Technology");
	});

	it("Returns an empty asset payload when the user has not tracked anything yet.", async () => {
		const testUser = await createTestUser({
			email: `asset-prices-empty-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const response = await getAssetPrices(
			createApiContext({
				request: new Request("http://localhost/api/assets/prices", {
					method: "GET",
				}),
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			assets: Record<string, unknown>;
		};
		expect(payload.ok).toBe(true);
		expect(payload.assets).toEqual({});
	});

	it("Rejects a logged-out asset price request.", async () => {
		const response = await getAssetPrices(
			createApiContext({
				request: new Request("http://localhost/api/assets/prices", {
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
