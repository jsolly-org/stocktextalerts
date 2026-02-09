import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import type { NotificationPreferences } from "../../src/lib/db";
import { POST as assetsUpdatePost } from "../../src/pages/api/assets/update";
import { getAssetData } from "./asset-data";
import { TEST_PASSWORD } from "./constants";
import { adminClient, createAuthenticatedCookies } from "./test-env";
import type { CreateTestUserOptions, TestUser } from "./test-user";
import { createTestUser } from "./test-user";

async function ensureAssetsExist(symbols: string[]): Promise<void> {
	if (symbols.length === 0) return;
	const uniqueSymbols = [...new Set(symbols)];
	const assetRecords = uniqueSymbols.map((symbol) => {
		const assetData = getAssetData(symbol);
		return {
			symbol: assetData.symbol,
			name: assetData.name,
			type: assetData.type,
		};
	});
	const { error } = await adminClient
		.from("assets")
		.upsert(assetRecords, { onConflict: "symbol" });
	if (error) {
		throw new Error(`Failed to ensure assets exist: ${error.message}`);
	}
}

export async function updateTrackedAssets(
	initialAssets: string[],
	assetsToUpdate: string[],
	userOverrides: Omit<CreateTestUserOptions, "trackedAssets"> = {},
	registerForCleanup?: (userId: string) => void,
): Promise<{
	response: Response;
	testUser: TestUser;
	trackedAssets: Array<{ symbol: string }> | null;
	payload: { ok: boolean; message: string };
	notificationPreferencesBefore: NotificationPreferences | null;
	notificationPreferencesAfter: NotificationPreferences | null;
}> {
	const testUser = await createTestUser({
		email: `test-${randomUUID()}@resend.dev`,
		password: TEST_PASSWORD,
		trackedAssets: initialAssets,
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
			"email_notifications_enabled,sms_notifications_enabled,scheduled_update_times,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	const cookies = await createAuthenticatedCookies(
		testUser.email,
		TEST_PASSWORD,
	);

	await ensureAssetsExist(assetsToUpdate);

	const formData = new FormData();
	formData.append("tracked_assets", JSON.stringify(assetsToUpdate));

	const request = new Request("http://localhost/api/assets/update", {
		method: "POST",
		body: formData,
	});

	const response = await assetsUpdatePost({
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

	const { data: trackedAssets } = await adminClient
		.from("user_assets")
		.select("symbol")
		.eq("user_id", testUser.id)
		.order("symbol");

	const { data: notificationPreferencesAfter } = await adminClient
		.from("users")
		.select(
			"email_notifications_enabled,sms_notifications_enabled,scheduled_update_times,next_send_at",
		)
		.eq("id", testUser.id)
		.maybeSingle();

	return {
		response,
		testUser,
		trackedAssets,
		payload,
		notificationPreferencesBefore,
		notificationPreferencesAfter,
	};
}
