import { describe, expect, it } from "vitest";
import { rootLogger } from "../../../../src/lib/logging";
import { fetchMarketScheduledUsers } from "../../../../src/lib/market-notifications/scheduled/query";
import type { UserRecord } from "../../../../src/lib/types";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

/**
 * Candidate-query coverage for market-scheduled. Same HAS_ACTIVE_DELIVERY_OR
 * filter as daily digest — Telegram-routed users must be selected; disabled excluded.
 */
describe("fetchMarketScheduledUsers candidate selection", () => {
	it("selects a Telegram-routed subscriber with a linked chat", async () => {
		const user = await createTestUser({
			deliveryChannel: "telegram",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);

		const { error } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_enabled: true,
				market_scheduled_asset_price_times: [570],
				telegram_chat_id: 991234568,
			})
			.eq("id", user.id);
		expect(error).toBeNull();
		await setTestUserPrefs(user.id, [["market_scheduled_asset_price", "", true]]);

		const users = await fetchMarketScheduledUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		const found = users.find((u: UserRecord) => u.id === user.id);
		expect(found, "telegram-routed user must be a market-scheduled candidate").toBeDefined();
		expect(found?.delivery_channel).toBe("telegram");
	});

	it("excludes a user with delivery_channel disabled", async () => {
		const user = await createTestUser({
			deliveryChannel: "disabled",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		const { error } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_enabled: true,
				market_scheduled_asset_price_times: [570],
			})
			.eq("id", user.id);
		expect(error).toBeNull();

		const users = await fetchMarketScheduledUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		expect(users.some((u: UserRecord) => u.id === user.id)).toBe(false);
	});

	it("selects an email-routed subscriber", async () => {
		const user = await createTestUser({
			deliveryChannel: "email",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);

		const { error } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_enabled: true,
				market_scheduled_asset_price_times: [570],
			})
			.eq("id", user.id);
		expect(error).toBeNull();
		await setTestUserPrefs(user.id, [["market_scheduled_asset_price", "", true]]);

		const users = await fetchMarketScheduledUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		const found = users.find((u: UserRecord) => u.id === user.id);
		expect(found, "email-routed user must be a market-scheduled candidate").toBeDefined();
		expect(found?.delivery_channel).toBe("email");
		expect(
			found?.prefs.some(
				(p) =>
					p.notification_type === "market_scheduled_asset_price" && p.content === "" && p.enabled,
			),
		).toBe(true);
	});
});
