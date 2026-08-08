import { describe, expect, it } from "vitest";
import {
	buildPreferenceSnapshot,
	loadUserPreferenceRows,
} from "../../../src/lib/notification-preferences/preferences";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Integration test for the "single source of truth" consolidation: per-option
 * content preferences live ONLY in notification_preferences, and the read path
 * (loadUserPreferenceRows → buildPreferenceSnapshot) faithfully reflects
 * what's in the table. Account routing lives on users.delivery_channel.
 */
describe("notification_preferences round-trips through the read path", () => {
	it("table rows are read back and projected into the dashboard snapshot", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		await setTestUserPrefs(user.id, [
			["price_move_alerts", "", true],
			["daily_notification", "news", true],
			["daily_notification", "prices", false], // explicitly OFF (overrides any default)
		]);

		const rows = await loadUserPreferenceRows(adminClient, user.id);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					notification_type: "price_move_alerts",
					content: "",
					enabled: true,
				}),
				expect.objectContaining({
					notification_type: "daily_notification",
					content: "news",
					enabled: true,
				}),
			]),
		);
		expect(rows.every((r) => !("channel" in r))).toBe(true);

		const snapshot = buildPreferenceSnapshot(rows);
		// Facet-less type → `<type>_include`; faceted → `<family>_include_<facet>`.
		expect(snapshot.price_move_alerts_include).toBe(true);
		expect(snapshot.daily_digest_include_news).toBe(true);
		expect(snapshot.daily_digest_include_prices).toBe(false);
	});

	it("the DB rejects preference rows for combos outside the notification_options catalog", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		// price_move_alerts is facet-less (content ""), so "prices" is never a
		// valid content for it. parsePrefRow validates type/content
		// independently — it is combo-blind — so the composite FK added by the
		// notification_options migration is the ONLY thing rejecting this row. Pin it.
		const { error } = await adminClient.from("notification_preferences").insert({
			user_id: user.id,
			notification_type: "price_move_alerts",
			content: "prices",
			enabled: true,
		});

		expect(error?.code).toBe("23503");
	});
});
