import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import type { NotificationPreferences } from "../../src/lib/db";
import { POST as stocksUpdatePost } from "../../src/pages/api/stocks/update";
import { TEST_PASSWORD } from "./constants";
import {
	adminClient,
	createAuthenticatedCookies,
	createTestUser,
	getStockData,
} from "./shared-utils";
import type { CreateTestUserOptions, TestUser } from "./test-user";

async function ensureStocksExist(symbols: string[]): Promise<void> {
	if (symbols.length === 0) return;
	const uniqueSymbols = [...new Set(symbols)];
	const stockRecords = uniqueSymbols.map((symbol) => {
		const stockData = getStockData(symbol);
		return {
			symbol: stockData.symbol,
			name: stockData.name,
			exchange: stockData.exchange,
		};
	});
	const { error } = await adminClient
		.from("stocks")
		.upsert(stockRecords, { onConflict: "symbol" });
	if (error) {
		throw new Error(`Failed to ensure stocks exist: ${error.message}`);
	}
}

export async function updateTrackedStocks(
	initialStocks: string[],
	stocksToUpdate: string[],
	userOverrides: Omit<CreateTestUserOptions, "trackedStocks"> = {},
	registerForCleanup?: (userId: string) => void,
): Promise<{
	response: Response;
	testUser: TestUser;
	trackedStocks: Array<{ symbol: string }> | null;
	payload: { ok: boolean; message: string };
	notificationPreferencesBefore: NotificationPreferences | null;
	notificationPreferencesAfter: NotificationPreferences | null;
}> {
	const testUser = await createTestUser({
		email: `test-${randomUUID()}@resend.dev`,
		password: TEST_PASSWORD,
		trackedStocks: initialStocks,
		...userOverrides,
	});
	registerForCleanup?.(testUser.id);

	const { error: confirmError } = await adminClient.auth.admin.updateUserById(
		testUser.id,
		{
			email_confirm: true,
		},
	);
	if (confirmError) {
		throw new Error(`Failed to confirm user: ${confirmError.message}`);
	}

	const { data: notificationPreferencesBefore } = await adminClient
		.from("users")
		.select(
			"email_notifications_enabled,sms_notifications_enabled,scheduled_updates_enabled,scheduled_update_times,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	const cookies = await createAuthenticatedCookies(
		testUser.email,
		TEST_PASSWORD,
	);

	await ensureStocksExist(stocksToUpdate);

	const formData = new FormData();
	formData.append("tracked_stocks", JSON.stringify(stocksToUpdate));

	const request = new Request("http://localhost/api/stocks/update", {
		method: "POST",
		body: formData,
	});

	const response = await stocksUpdatePost({
		request,
		cookies: {
			get: (name: string) => {
				const value = cookies.get(name);
				return value ? { value } : undefined;
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

	const { data: notificationPreferencesAfter } = await adminClient
		.from("users")
		.select(
			"email_notifications_enabled,sms_notifications_enabled,scheduled_updates_enabled,scheduled_update_times,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	return {
		response,
		testUser,
		trackedStocks,
		payload,
		notificationPreferencesBefore,
		notificationPreferencesAfter,
	};
}
