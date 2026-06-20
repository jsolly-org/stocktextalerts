import { describe, expect, it } from "vitest";
import {
	buildChannelPreferenceSnapshot,
	loadUserPreferenceRows,
} from "../../../src/lib/api/notification-preferences-channels";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Integration test for the "single source of truth" consolidation: per-option
 * channel preferences live ONLY in notification_preferences, and the read path
 * (loadUserPreferenceRows → buildChannelPreferenceSnapshot) faithfully reflects
 * what's in the table for every channel (email, sms, telegram alike).
 */
describe("notification_preferences round-trips through the read path", () => {
	it("table rows are read back and projected into the dashboard snapshot", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		await setTestUserPrefs(user.id, [
			["price_targets", "", "telegram", true],
			["daily_digest", "news", "telegram", true],
			["daily_digest", "prices", "email", false], // explicitly OFF (overrides any default)
		]);

		const rows = await loadUserPreferenceRows(adminClient, user.id);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					notification_type: "price_targets",
					content: "",
					channel: "telegram",
					enabled: true,
				}),
				expect.objectContaining({
					notification_type: "daily_digest",
					content: "news",
					channel: "telegram",
					enabled: true,
				}),
			]),
		);

		const snapshot = buildChannelPreferenceSnapshot(rows);
		// Facet-less type → `<type>_include_<channel>`; faceted → `<type>_include_<facet>_<channel>`.
		expect(snapshot.price_targets_include_telegram).toBe(true);
		expect(snapshot.daily_digest_include_news_telegram).toBe(true);
		expect(snapshot.daily_digest_include_prices_email).toBe(false);
	});
});
