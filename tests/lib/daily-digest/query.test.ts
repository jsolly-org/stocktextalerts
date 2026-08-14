import { describe, expect, it } from "vitest";
import { fetchDailyNotificationUsers } from "../../../src/lib/daily-notification/query";
import { rootLogger } from "../../../src/lib/logging";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Candidate-query coverage for the daily digest. The `.or()` channel filter can't
 * reference notification_preferences (PostgREST one-table limit), so candidacy is
 * gated on channel-level columns — which must include a linked Telegram chat, or
 * Telegram-only subscribers are silently never selected.
 */
describe("fetchDailyNotificationUsers daily-digest candidate selection", () => {
	it("selects a Telegram-only subscriber (delivery_channel telegram, chat linked)", async () => {
		const user = await createTestUser({
			deliveryChannel: "telegram",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);

		// Routed to Telegram with a linked chat + daily prices facet on.
		const { error } = await adminClient
			.from("users")
			.update({
				daily_notification_time: 540,
				telegram_chat_id: 991234567,
			})
			.eq("id", user.id);
		expect(error).toBeNull();
		await setTestUserPrefs(user.id, [["daily_notification", "prices", true]]);

		const users = await fetchDailyNotificationUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		const found = users.find((u) => u.id === user.id);
		expect(found, "telegram-only user must be a daily-digest candidate").toBeDefined();
		expect(found?.delivery_channel).toBe("telegram");
		// prefs are attached so downstream per-facet filtering can run.
		expect(
			found?.prefs.some(
				(p) => p.notification_type === "daily_notification" && p.content === "prices" && p.enabled,
			),
		).toBe(true);
	});

	it("excludes a user with no daily notification facets enabled", async () => {
		const user = await createTestUser({
			deliveryChannel: "email",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		const { error } = await adminClient
			.from("users")
			.update({
				daily_notification_next_send_at: new Date().toISOString(),
			})
			.eq("id", user.id);
		expect(error).toBeNull();
		await setTestUserPrefs(user.id, [["daily_notification", "prices", false]]);

		const users = await fetchDailyNotificationUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		expect(users.some((u) => u.id === user.id)).toBe(false);
	});

	it("excludes a user with no usable channel (email off, no Telegram)", async () => {
		const user = await createTestUser({
			deliveryChannel: "disabled",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		const { error } = await adminClient
			.from("users")
			.update({ daily_notification_time: 540 })
			.eq("id", user.id);
		expect(error).toBeNull();

		const users = await fetchDailyNotificationUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		expect(users.some((u) => u.id === user.id)).toBe(false);
	});

	it("selects a user with prices off when another daily facet is on", async () => {
		const user = await createTestUser({
			deliveryChannel: "email",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		await setTestUserPrefs(user.id, [
			["daily_notification", "prices", false],
			["daily_notification", "top_movers", true],
		]);

		const users = await fetchDailyNotificationUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		const found = users.find((u) => u.id === user.id);
		expect(found, "user with a non-price daily facet on must be a candidate").toBeDefined();
		expect(
			found?.prefs.some(
				(p) =>
					p.notification_type === "daily_notification" && p.content === "top_movers" && p.enabled,
			),
		).toBe(true);
	});

	it("excludes a stock-buyer lambda user even with a due cursor", async () => {
		const user = await createTestUser({
			deliveryChannel: "lambda",
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		const { error } = await adminClient
			.from("users")
			.update({
				daily_notification_next_send_at: new Date().toISOString(),
			})
			.eq("id", user.id);
		expect(error).toBeNull();
		await setTestUserPrefs(user.id, [["daily_notification", "prices", true]]);

		const users = await fetchDailyNotificationUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		expect(users.some((u) => u.id === user.id)).toBe(false);
	});
});
