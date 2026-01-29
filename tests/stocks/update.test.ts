import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TRACKED_STOCKS } from "../../src/lib/db/database-errors";
import { rootLogger } from "../../src/lib/logging";
import { POST } from "../../src/pages/api/stocks/update";
import { adminClient } from "../setup";
import {
	type CreateTestUserOptions,
	cleanupTestUser,
	createAuthenticatedCookies,
	createTestUser,
	getRealStockSymbols,
	getStockData,
	type TestUser,
} from "../utils";

const TEST_PASSWORD = "TestPassword123!";
const createdUserIds: string[] = [];

afterEach(async () => {
	if (createdUserIds.length === 0) {
		return;
	}

	const userIds = createdUserIds.splice(0, createdUserIds.length);
	for (const userId of userIds) {
		await cleanupTestUser(userId);
	}
});

type UserNotificationPreferences = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	daily_digest_enabled: boolean;
	daily_digest_notification_times: number[] | null;
	next_send_at: string | null;
};

async function updateTrackedStocks(
	initialStocks: string[],
	stocksToUpdate: string[],
	userOverrides: Omit<CreateTestUserOptions, "trackedStocks"> = {},
): Promise<{
	response: Response;
	testUser: TestUser;
	trackedStocks: Array<{ symbol: string }> | null;
	payload: { ok: boolean; message: string };
	userPreferencesBefore: UserNotificationPreferences | null;
	userPreferencesAfter: UserNotificationPreferences | null;
}> {
	const testUser = await createTestUser({
		email: `test-${randomUUID()}@resend.dev`,
		password: TEST_PASSWORD,
		trackedStocks: initialStocks,
		...userOverrides,
	});
	createdUserIds.push(testUser.id);

	const { error: confirmError } = await adminClient.auth.admin.updateUserById(
		testUser.id,
		{
			email_confirm: true,
		},
	);
	if (confirmError) {
		throw new Error(`Failed to confirm user: ${confirmError.message}`);
	}

	const { data: userPreferencesBefore } = await adminClient
		.from("users")
		.select(
			"email_notifications_enabled,sms_notifications_enabled,daily_digest_enabled,daily_digest_notification_times,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	const cookies = await createAuthenticatedCookies(
		testUser.email,
		TEST_PASSWORD,
	);

	const formData = new FormData();
	formData.append("tracked_stocks", JSON.stringify(stocksToUpdate));

	const request = new Request("http://localhost/api/stocks/update", {
		method: "POST",
		body: formData,
	});

	const response = await POST({
		request,
		cookies: {
			get: (name: string) => {
				const cookie = cookies.get(name);
				return cookie ? { value: cookie } : undefined;
			},
			set: () => {},
		},
	} as unknown as APIContext);
	const payload = (await response.json()) as { ok: boolean; message: string };

	const { data: trackedStocks } = await adminClient
		.from("user_stocks")
		.select("symbol")
		.eq("user_id", testUser.id)
		.order("symbol");

	const { data: userPreferencesAfter } = await adminClient
		.from("users")
		.select(
			"email_notifications_enabled,sms_notifications_enabled,daily_digest_enabled,daily_digest_notification_times,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	return {
		response,
		testUser,
		trackedStocks,
		payload,
		userPreferencesBefore,
		userPreferencesAfter,
	};
}

describe("POST /api/stocks/update", () => {
	it("should add a single stock when user has no stocks", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			[],
			["AAPL"],
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(1);
		expect(trackedStocks?.[0]?.symbol).toBe("AAPL");
	});

	it("should remove the single stock when user has one stock", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["AAPL"],
			[],
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(0);
	});

	it("should add a second stock when user has one stock", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["AAPL"],
			["AAPL", "MSFT"],
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(2);
		expect(trackedStocks?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("should not change notification preferences when submitting tracked_stocks only", async () => {
		const { userPreferencesAfter, userPreferencesBefore, payload, response } =
			await updateTrackedStocks(["AAPL"], ["AAPL", "MSFT"], {
				emailNotificationsEnabled: true,
				smsNotificationsEnabled: false,
				dailyDigestEnabled: false,
				dailyDigestNotificationTimes: [600],
			});

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(userPreferencesBefore).not.toBeNull();
		expect(userPreferencesAfter).not.toBeNull();
		expect(userPreferencesAfter).toEqual(userPreferencesBefore);
	});

	it("should successfully replace existing tracked stocks", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["TSLA", "NVDA"],
			["AAPL", "MSFT"],
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(2);
		expect(trackedStocks?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("should successfully clear all tracked stocks", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["AAPL", "MSFT", "GOOGL"],
			[],
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(0);
	});

	it("should reject when attempting to track more than MAX_TRACKED_STOCKS", async () => {
		const seedSymbols = getRealStockSymbols(MAX_TRACKED_STOCKS + 1);
		const seedRecords = seedSymbols.map((symbol) => {
			const stockData = getStockData(symbol);
			return {
				symbol: stockData.symbol,
				name: stockData.name,
				exchange: stockData.exchange,
			};
		});

		const { error: insertError } = await adminClient
			.from("stocks")
			.upsert(seedRecords, { onConflict: "symbol" });
		expect(insertError).toBeNull();

		try {
			const initialStocks = seedSymbols.slice(0, MAX_TRACKED_STOCKS);
			const stocksExceedingLimit = seedSymbols.slice(0, MAX_TRACKED_STOCKS + 1);

			const { response, trackedStocks, payload } = await updateTrackedStocks(
				initialStocks,
				stocksExceedingLimit,
			);

			expect(response.status).toBe(400);
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("stocks_limit");

			expect(trackedStocks).toHaveLength(MAX_TRACKED_STOCKS);
		} finally {
			const { error: stockDeleteError } = await adminClient
				.from("stocks")
				.delete()
				.in("symbol", seedSymbols);
			if (stockDeleteError) {
				rootLogger.warn("Cleanup failed (stocks)", { error: stockDeleteError });
			}
		}
	});
});
