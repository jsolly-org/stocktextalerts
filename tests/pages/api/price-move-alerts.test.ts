import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/price-move-alerts";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * The endpoint writes through the service-role admin client (RLS bypass), so
 * its in-code session-auth + watchlist-membership + bounds checks are the ONLY
 * authz layer — these tests pin each guard plus the upsert/clear round-trip.
 */
function postThreshold(body: unknown, cookies?: Map<string, string>) {
	return POST(
		createApiContext({
			request: new Request("http://localhost/api/price-move-alerts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			...(cookies ? { cookies } : {}),
		}),
	);
}

async function makeTrackedUser() {
	const testUser = await createTestUser({
		email: `pma-${randomUUID()}@example.com`,
		password: TEST_PASSWORD,
		confirmed: true,
		trackedAssets: ["AAPL"],
	});
	registerTestUserForCleanup(testUser.id);
	const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);
	return { testUser, cookies };
}

async function getThresholdRow(userId: string, symbol: string) {
	const { data, error } = await adminClient
		.from("price_move_alert_thresholds")
		.select("threshold_value, threshold_unit")
		.eq("user_id", userId)
		.eq("symbol", symbol)
		.maybeSingle();
	expect(error).toBeNull();
	return data;
}

describe("A signed-in user manages per-stock price-move thresholds.", () => {
	it("An unauthenticated request is rejected with 401 and writes nothing.", async () => {
		const response = await postThreshold({ symbol: "AAPL", value: 5, unit: "percent" });
		expect(response.status).toBe(401);
	});

	it("Setting a percent threshold on a tracked stock persists the row.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "AAPL", value: 3, unit: "percent" }, cookies);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: true, message: "threshold_saved" });

		const row = await getThresholdRow(testUser.id, "AAPL");
		expect(Number(row?.threshold_value)).toBe(3);
		expect(row?.threshold_unit).toBe("percent");
	});

	it("Re-saving with a dollar unit upserts over the existing row.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		await postThreshold({ symbol: "AAPL", value: 5, unit: "percent" }, cookies);
		const response = await postThreshold({ symbol: "AAPL", value: 12, unit: "dollar" }, cookies);
		expect(response.status).toBe(200);

		const row = await getThresholdRow(testUser.id, "AAPL");
		expect(Number(row?.threshold_value)).toBe(12);
		expect(row?.threshold_unit).toBe("dollar");
	});

	it("A null value clears the threshold (opts the stock out).", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		await postThreshold({ symbol: "AAPL", value: 5, unit: "percent" }, cookies);
		const response = await postThreshold({ symbol: "AAPL", value: null, unit: "percent" }, cookies);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: true, message: "threshold_cleared" });

		expect(await getThresholdRow(testUser.id, "AAPL")).toBeNull();
	});

	it("A symbol outside the user's watchlist is rejected and writes nothing.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "MSFT", value: 5, unit: "percent" }, cookies);
		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: false, message: "asset_not_tracked" });

		expect(await getThresholdRow(testUser.id, "MSFT")).toBeNull();
	});

	it("A malformed symbol is rejected before any DB lookup.", async () => {
		const { cookies } = await makeTrackedUser();

		const response = await postThreshold(
			{ symbol: "not a ticker!", value: 5, unit: "percent" },
			cookies,
		);
		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: false, message: "invalid_symbol" });
	});

	it("An unknown unit is rejected with 400 instead of silently coercing to percent.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "AAPL", value: 5, unit: "dollars" }, cookies);
		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: false, message: "invalid_unit" });

		expect(await getThresholdRow(testUser.id, "AAPL")).toBeNull();
	});

	it("Out-of-bounds values (zero, sub-min, fractional, negative, above the unit ceiling) are rejected.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		for (const [value, unit] of [
			[0, "percent"],
			[0.5, "percent"],
			[2.5, "percent"],
			[-3, "percent"],
			[101, "percent"],
			[100_001, "dollar"],
		] as const) {
			const response = await postThreshold({ symbol: "AAPL", value, unit }, cookies);
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { ok: boolean; message: string };
			expect(payload).toEqual({ ok: false, message: "invalid_value" });
		}

		expect(await getThresholdRow(testUser.id, "AAPL")).toBeNull();
	});

	it("Inclusive unit floors and ceilings (1 / 100% / $100_000) are accepted.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const floorResponse = await postThreshold(
			{ symbol: "AAPL", value: 1, unit: "percent" },
			cookies,
		);
		expect(floorResponse.status).toBe(200);
		expect(await getThresholdRow(testUser.id, "AAPL")).toMatchObject({
			threshold_value: 1,
			threshold_unit: "percent",
		});

		const percentResponse = await postThreshold(
			{ symbol: "AAPL", value: 100, unit: "percent" },
			cookies,
		);
		expect(percentResponse.status).toBe(200);
		expect(await getThresholdRow(testUser.id, "AAPL")).toMatchObject({
			threshold_value: 100,
			threshold_unit: "percent",
		});

		const dollarResponse = await postThreshold(
			{ symbol: "AAPL", value: 100_000, unit: "dollar" },
			cookies,
		);
		expect(dollarResponse.status).toBe(200);
		expect(await getThresholdRow(testUser.id, "AAPL")).toMatchObject({
			threshold_value: 100_000,
			threshold_unit: "dollar",
		});
	});
});
