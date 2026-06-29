/**
 * Integration test for the standalone asset-events Telegram dispatch wiring.
 *
 * Scenario: a Telegram-linked user who selected the asset_events "calendar" facet
 * for the Telegram channel (email/SMS off) runs through `processAssetEventsUser`
 * and receives a Telegram asset-events digest — a notification_log row with
 * delivery_method='telegram', the telegram scheduled_notifications row marked
 * sent, and stats.telegramSent incremented. Disabling the facet skips Telegram.
 *
 * Uses the real Supabase client + seeded user for the claim/log path. The content
 * builder is mocked so the test doesn't need to seed the upstream asset_events /
 * finnhub tables — facet-driven section rendering is covered in content.test.ts.
 */
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { buildAssetEventsContentForChannels } from "../../../src/lib/asset-events/content";
import { processAssetEventsUser } from "../../../src/lib/asset-events/process";
import { rootLogger } from "../../../src/lib/logging";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import { attachPrefsToUsers } from "../../../src/lib/messaging/load-prefs";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import type { UserRecord } from "../../../src/lib/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

vi.mock("../../../src/lib/asset-events/content", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/asset-events/content")>(
		"../../../src/lib/asset-events/content",
	);
	return { ...actual, buildAssetEventsContentForChannels: vi.fn() };
});

async function seedTelegramAssetEventsUser(facetEnabled: boolean) {
	const now = DateTime.utc();
	const { id } = await createTestUser({
		timezone: "America/New_York",
		emailNotificationsEnabled: false,
		smsNotificationsEnabled: false,
		trackedAssets: ["NVDA"],
		confirmed: true,
	});
	registerTestUserForCleanup(id);

	const telegramChatId = 663300;
	const { error: updateError } = await adminClient
		.from("users")
		.update({
			daily_notification_next_send_at: now.toISO(),
			telegram_chat_id: telegramChatId,
			telegram_opted_out: false,
		})
		.eq("id", id);
	expect(updateError).toBeNull();

	// Per-option prefs live in notification_preferences (createTestUser seeded the
	// asset_events Telegram facets off); set the calendar facet for this test.
	await setTestUserPrefs(id, [["daily_notification", "calendar", "telegram", facetEnabled]]);

	const { data: userRow, error: selectError } = await adminClient
		.from("users")
		.select("*")
		.eq("id", id)
		.single();
	expect(selectError).toBeNull();
	if (!userRow) throw new Error("expected seeded user row");
	// processAssetEventsUser reads user.prefs, so attach the freshly-seeded rows.
	const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);
	return { id, telegramChatId, userRow: userWithPrefs as unknown as UserRecord, now };
}

describe("Telegram standalone asset-events dispatch", () => {
	it("A Telegram-linked user with the asset_events calendar facet enabled receives a Telegram digest.", async () => {
		const { id, telegramChatId, userRow, now } = await seedTelegramAssetEventsUser(true);

		// Only the Telegram calendar facet is on → builder returns a telegram block
		// carrying the earnings section; email/sms are null.
		vi.mocked(buildAssetEventsContentForChannels).mockResolvedValue({
			email: null,
			sms: null,
			telegram: {
				eventsSection: {
					earnings: "NVDA: Earnings tomorrow",
					dividends: null,
					splits: null,
					ipos: null,
				},
				insiderSection: null,
				analystSection: null,
				hasAnyContent: true,
			},
			analystFetchAttempted: false,
			shouldUpdateAnalystMonth: false,
		});

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const telegramSender = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "tg-ae-1",
		}));

		const stats = await processAssetEventsUser({
			user: userRow,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			marketClosureInfo: null,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
			getTelegramSender: () => ({ sender: telegramSender }),
		});

		expect(stats.telegramSent).toBe(1);
		expect(stats.telegramFailed).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(smsSender).not.toHaveBeenCalled();
		expect(telegramSender).toHaveBeenCalledTimes(1);

		const sent = telegramSender.mock.calls[0]?.[0];
		expect(sent?.chatId).toBe(telegramChatId);
		expect(sent?.text).toContain("Earnings");

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("delivery_method, message_delivered, type")
			.eq("user_id", id)
			.eq("delivery_method", "telegram");
		expect(logs).toHaveLength(1);
		expect(logs?.[0]?.message_delivered).toBe(true);
		expect(logs?.[0]?.type).toBe("asset_events");

		const { data: scheduled } = await adminClient
			.from("scheduled_notifications")
			.select("status, channel")
			.eq("user_id", id)
			.eq("notification_type", "asset_events")
			.eq("channel", "telegram")
			.maybeSingle();
		expect(scheduled?.status).toBe("sent");
	});

	it("A Telegram-linked user with the asset_events facet disabled receives no Telegram message.", async () => {
		const { id, userRow, now } = await seedTelegramAssetEventsUser(false);

		// No facet on → builder is never reached for telegram; return empty.
		vi.mocked(buildAssetEventsContentForChannels).mockResolvedValue({
			email: null,
			sms: null,
			telegram: null,
			analystFetchAttempted: false,
			shouldUpdateAnalystMonth: false,
		});

		const telegramSender = vi.fn<TelegramSender>(async () => ({ success: true }));

		const stats = await processAssetEventsUser({
			user: userRow,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			marketClosureInfo: null,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({ sender: vi.fn<SmsSender>(async () => ({ success: true })) }),
			getTelegramSender: () => ({ sender: telegramSender }),
		});

		expect(telegramSender).not.toHaveBeenCalled();
		expect(stats.telegramSent).toBe(0);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("delivery_method")
			.eq("user_id", id)
			.eq("delivery_method", "telegram");
		expect(logs).toHaveLength(0);
	});
});
