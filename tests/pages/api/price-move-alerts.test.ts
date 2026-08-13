import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PRICE_MOVE_ALERT_THRESHOLD_PERCENT } from "../../../src/lib/constants";
import { POST } from "../../../src/pages/api/price-move-alerts";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

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

describe("A signed-in user manages per-stock price-move alerts.", () => {
	it("An unauthenticated request is rejected with 401 and writes nothing.", async () => {
		const response = await postThreshold({ symbol: "AAPL", enabled: true });
		expect(response.status).toBe(401);
	});

	it("{ enabled: true } persists a 5% percent row.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "AAPL", enabled: true }, cookies);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: true, message: "threshold_saved" });

		const row = await getThresholdRow(testUser.id, "AAPL");
		expect(Number(row?.threshold_value)).toBe(PRICE_MOVE_ALERT_THRESHOLD_PERCENT);
		expect(row?.threshold_unit).toBe("percent");
	});

	it("A legacy { value: 12, unit: dollar } still persists 5% percent (lock-down).", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "AAPL", value: 12, unit: "dollar" }, cookies);
		expect(response.status).toBe(200);

		const row = await getThresholdRow(testUser.id, "AAPL");
		expect(Number(row?.threshold_value)).toBe(PRICE_MOVE_ALERT_THRESHOLD_PERCENT);
		expect(row?.threshold_unit).toBe("percent");
	});

	it("{ enabled: false } clears the threshold (opts the stock out).", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		await postThreshold({ symbol: "AAPL", enabled: true }, cookies);
		const response = await postThreshold({ symbol: "AAPL", enabled: false }, cookies);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: true, message: "threshold_cleared" });

		expect(await getThresholdRow(testUser.id, "AAPL")).toBeNull();
	});

	it("A null value clears the threshold (opts the stock out).", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		await postThreshold({ symbol: "AAPL", enabled: true }, cookies);
		const response = await postThreshold({ symbol: "AAPL", value: null }, cookies);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: true, message: "threshold_cleared" });

		expect(await getThresholdRow(testUser.id, "AAPL")).toBeNull();
	});

	it("A symbol outside the user's watchlist is rejected and writes nothing.", async () => {
		const { testUser, cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "MSFT", enabled: true }, cookies);
		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: false, message: "asset_not_tracked" });

		expect(await getThresholdRow(testUser.id, "MSFT")).toBeNull();
	});

	it("A malformed symbol is rejected before any DB lookup.", async () => {
		const { cookies } = await makeTrackedUser();

		const response = await postThreshold({ symbol: "not a ticker!", enabled: true }, cookies);
		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload).toEqual({ ok: false, message: "invalid_symbol" });
	});
});
