import { describe, expect, it } from "vitest";
import { fetchDailyDigestUsers } from "../../../src/lib/daily-digest/query";
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
describe("fetchDailyDigestUsers candidate selection", () => {
	it("selects a Telegram-only subscriber (email + SMS off, Telegram linked)", async () => {
		const user = await createTestUser({
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: false,
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);

		// No usable email/SMS channel, but a linked Telegram chat + the daily_digest
		// prices Telegram facet on — a legitimate Telegram-only digest subscriber.
		const { error } = await adminClient
			.from("users")
			.update({ daily_digest_time: 540, telegram_chat_id: 991234567, telegram_opted_out: false })
			.eq("id", user.id);
		expect(error).toBeNull();
		await setTestUserPrefs(user.id, [["daily_digest", "prices", "telegram", true]]);

		const users = await fetchDailyDigestUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		const found = users.find((u) => u.id === user.id);
		expect(found, "telegram-only user must be a daily-digest candidate").toBeDefined();
		// prefs are attached so downstream per-facet filtering can run.
		expect(
			found?.prefs.some(
				(p) =>
					p.notification_type === "daily_digest" &&
					p.content === "prices" &&
					p.channel === "telegram" &&
					p.enabled,
			),
		).toBe(true);
	});

	it("excludes a user with no usable channel (email + SMS off, no Telegram)", async () => {
		const user = await createTestUser({
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: false,
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		const { error } = await adminClient
			.from("users")
			.update({ daily_digest_time: 540 })
			.eq("id", user.id);
		expect(error).toBeNull();

		const users = await fetchDailyDigestUsers({
			supabase: adminClient,
			logger: rootLogger,
			forceSend: true,
			currentTimeIso: new Date().toISOString(),
		});

		expect(users.some((u) => u.id === user.id)).toBe(false);
	});
});
