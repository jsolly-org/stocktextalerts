import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { MAX_TRACKED_STOCKS } from "../../../../src/lib/db/database-errors";
import { POST } from "../../../../src/pages/api/preferences";
import { adminClient } from "../../../setup";
import {
	type CreateTestUserOptions,
	createAuthenticatedCookies,
	createTestUser,
	type TestUser,
} from "../../../utils";

const TEST_PASSWORD = "TestPassword123!";

type UserNotificationPreferences = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	daily_digest_enabled: boolean;
	daily_digest_notification_time: number;
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
	redirectUrl: string | null;
	userPreferencesBefore: UserNotificationPreferences | null;
	userPreferencesAfter: UserNotificationPreferences | null;
}> {
	const testUser = await createTestUser({
		email: `test-${randomUUID()}@resend.dev`,
		password: TEST_PASSWORD,
		trackedStocks: initialStocks,
		...userOverrides,
	});

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
			"email_notifications_enabled,sms_notifications_enabled,daily_digest_enabled,daily_digest_notification_time,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	const cookies = await createAuthenticatedCookies(
		testUser.email,
		TEST_PASSWORD,
	);

	const formData = new FormData();
	formData.append("tracked_stocks", JSON.stringify(stocksToUpdate));

	const request = new Request("http://localhost/api/preferences", {
		method: "POST",
		body: formData,
	});

	let redirectUrl: string | null = null;
	const response = await POST({
		request,
		cookies: {
			get: (name: string) => {
				const cookie = cookies.get(name);
				return cookie ? { value: cookie } : undefined;
			},
			set: () => {},
		},
		redirect: (url: string) => {
			redirectUrl = url;
			return new Response(null, {
				status: 302,
				headers: { Location: url },
			});
		},
	} as unknown as APIContext);

	const { data: trackedStocks } = await adminClient
		.from("user_stocks")
		.select("symbol")
		.eq("user_id", testUser.id)
		.order("symbol");

	const { data: userPreferencesAfter } = await adminClient
		.from("users")
		.select(
			"email_notifications_enabled,sms_notifications_enabled,daily_digest_enabled,daily_digest_notification_time,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	return {
		response,
		testUser,
		trackedStocks,
		redirectUrl,
		userPreferencesBefore,
		userPreferencesAfter,
	};
}

describe("POST /api/preferences (tracked stocks)", () => {
	it("should add a single stock when user has no stocks", async () => {
		const { response, trackedStocks, redirectUrl } = await updateTrackedStocks(
			[],
			["AAPL"],
		);

		expect(redirectUrl).toBe("/dashboard?success=settings_updated");
		expect(response.status).toBe(302);

		expect(trackedStocks).toHaveLength(1);
		expect(trackedStocks?.[0]?.symbol).toBe("AAPL");
	});

	it("should remove the single stock when user has one stock", async () => {
		const { response, trackedStocks, redirectUrl } = await updateTrackedStocks(
			["AAPL"],
			[],
		);

		expect(redirectUrl).toBe("/dashboard?success=settings_updated");
		expect(response.status).toBe(302);

		expect(trackedStocks).toHaveLength(0);
	});

	it("should add a second stock when user has one stock", async () => {
		const { response, trackedStocks, redirectUrl } = await updateTrackedStocks(
			["AAPL"],
			["AAPL", "MSFT"],
		);

		expect(redirectUrl).toBe("/dashboard?success=settings_updated");
		expect(response.status).toBe(302);

		expect(trackedStocks).toHaveLength(2);
		expect(trackedStocks?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("should not change notification preferences when submitting tracked_stocks only", async () => {
		const {
			userPreferencesAfter,
			userPreferencesBefore,
			redirectUrl,
			response,
		} = await updateTrackedStocks(["AAPL"], ["AAPL", "MSFT"], {
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			dailyDigestEnabled: false,
			dailyDigestNotificationTime: 600,
		});

		expect(redirectUrl).toBe("/dashboard?success=settings_updated");
		expect(response.status).toBe(302);

		expect(userPreferencesBefore).not.toBeNull();
		expect(userPreferencesAfter).not.toBeNull();
		expect(userPreferencesAfter).toEqual(userPreferencesBefore);
	});

	it("should successfully replace existing tracked stocks", async () => {
		const { response, trackedStocks, redirectUrl } = await updateTrackedStocks(
			["TSLA", "NVDA"],
			["AAPL", "MSFT"],
		);

		expect(redirectUrl).toBe("/dashboard?success=settings_updated");
		expect(response.status).toBe(302);

		expect(trackedStocks).toHaveLength(2);
		expect(trackedStocks?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("should successfully clear all tracked stocks", async () => {
		const { response, trackedStocks, redirectUrl } = await updateTrackedStocks(
			["AAPL", "MSFT", "GOOGL"],
			[],
		);

		expect(redirectUrl).toBe("/dashboard?success=settings_updated");
		expect(response.status).toBe(302);

		expect(trackedStocks).toHaveLength(0);
	});

	it("should reject when attempting to track more than MAX_TRACKED_STOCKS", async () => {
		const initialStocks = Array.from(
			{ length: MAX_TRACKED_STOCKS },
			(_, i) => `STOCK${i + 1}`,
		);
		const stocksExceedingLimit = Array.from(
			{ length: MAX_TRACKED_STOCKS + 1 },
			(_, i) => `STOCK${i + 1}`,
		);

		const { response, trackedStocks, redirectUrl } = await updateTrackedStocks(
			initialStocks,
			stocksExceedingLimit,
		);

		expect(redirectUrl).toBe("/dashboard?error=stocks_limit");
		expect(response.status).toBe(302);

		expect(trackedStocks).toHaveLength(MAX_TRACKED_STOCKS);
		expect(trackedStocks?.length).toBeLessThanOrEqual(MAX_TRACKED_STOCKS);
	});
});
