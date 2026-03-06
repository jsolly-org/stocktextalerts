import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssetEventsContent } from "../../../src/lib/asset-events/content";
import { processAssetEventsEmailDelivery } from "../../../src/lib/asset-events/delivery";
import { processAssetEventsUser } from "../../../src/lib/asset-events/process";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { loadUserAssets } from "../../../src/lib/schedule/helpers";

vi.mock("../../../src/lib/schedule/helpers", async () => {
	const actual = await vi.importActual("../../../src/lib/schedule/helpers");
	return {
		...actual,
		loadUserAssets: vi.fn(),
	};
});

vi.mock("../../../src/lib/asset-events/content", async () => {
	const actual = await vi.importActual("../../../src/lib/asset-events/content");
	return {
		...actual,
		buildAssetEventsContent: vi.fn(),
	};
});

vi.mock("../../../src/lib/asset-events/delivery", async () => {
	const actual = await vi.importActual(
		"../../../src/lib/asset-events/delivery",
	);
	return {
		...actual,
		processAssetEventsEmailDelivery: vi.fn(),
		processAssetEventsSmsDelivery: vi.fn(),
	};
});

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
	return {
		id: "user-1",
		email: "test@example.com",
		phone_country_code: "1",
		phone_number: "5551112222",
		phone_verified: false,
		timezone: "UTC",
		market_scheduled_asset_price_next_send_at: null,
		email_notifications_enabled: true,
		sms_notifications_enabled: false,
		sms_opted_out: true,
		market_scheduled_asset_price_enabled: false,
		market_scheduled_asset_price_include_email: false,
		market_scheduled_asset_price_include_sms: false,
		market_scheduled_asset_price_times: null,
		daily_digest_time: null,
		daily_digest_next_send_at: null,
		asset_events_include_calendar_email: false,
		asset_events_include_calendar_sms: false,
		asset_events_include_ipo_email: true,
		asset_events_include_ipo_sms: false,
		asset_events_include_analyst_email: false,
		asset_events_include_analyst_sms: false,
		asset_events_include_insider_email: false,
		asset_events_include_insider_sms: false,
		asset_events_next_send_at: "2026-02-10T10:00:00.000Z",
		asset_events_last_analyst_sent_month: null,
		daily_digest_include_news_email: false,
		daily_digest_include_rumors_email: false,
		last_grok_rumors_at: null,
		grok_window_start: null,
		grok_sends_in_window: 0,
		...overrides,
	};
}

describe("processAssetEventsUser", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("continues processing IPO notifications even with zero tracked assets", async () => {
		vi.mocked(loadUserAssets).mockResolvedValue([]);
		vi.mocked(buildAssetEventsContent).mockResolvedValue({
			eventsSection: {
				earnings: null,
				dividends: null,
				splits: null,
				ipos: "ACME: IPO tomorrow",
			},
			insiderSection: null,
			analystSection: null,
			shouldUpdateAnalystMonth: false,
			hasAnyContent: true,
		});
		vi.mocked(processAssetEventsEmailDelivery).mockResolvedValue();

		const user = makeUser();
		const supabase = {
			from() {
				return {
					update() {
						return {
							eq() {
								return Promise.resolve({ error: null });
							},
						};
					},
				};
			},
		};
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

		const stats = await processAssetEventsUser({
			user,
			supabase: supabase as never,
			logger: logger as never,
			currentTime: DateTime.fromISO("2026-02-10T10:00:00.000Z"),
			sendEmail: vi.fn(async () => ({ success: true })) as never,
			getSmsSender: vi.fn(() => ({ sender: "+15555550123" })) as never,
		});

		expect(vi.mocked(buildAssetEventsContent)).toHaveBeenCalledWith(
			expect.objectContaining({ tickers: [] }),
		);
		expect(vi.mocked(processAssetEventsEmailDelivery)).toHaveBeenCalledOnce();
		expect(stats.skipped).toBe(0);
	});
});
