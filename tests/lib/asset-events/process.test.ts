import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssetEventsContent } from "../../../src/lib/asset-events/content";
import {
	processAssetEventsEmailDelivery,
	processAssetEventsTelegramDelivery,
} from "../../../src/lib/asset-events/delivery";
import { processAssetEventsUser } from "../../../src/lib/asset-events/process";
import { loadUserAssets } from "../../../src/lib/db/user-assets";

vi.mock("../../../src/lib/db/user-assets", async () => {
	const actual = await vi.importActual("../../../src/lib/db/user-assets");
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
	const actual = await vi.importActual("../../../src/lib/asset-events/delivery");
	return {
		...actual,
		processAssetEventsEmailDelivery: vi.fn(),
		processAssetEventsTelegramDelivery: vi.fn(),
	};
});

vi.mock("../../../src/lib/time/market/calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/lib/asset-events/schedule-state", () => ({
	shouldAdvanceAssetEventsSchedule: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/lib/daily-notification/schedule", () => ({
	updateUserDailyNotificationNextSendAt: vi.fn().mockResolvedValue(undefined),
}));

import type { UserRecord } from "../../../src/lib/types";
import { makePrefRows, makeUserRecord } from "../../helpers/user-record-fixture";

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
	return makeUserRecord({
		prefs: makePrefRows([["daily_notification", "ipo", true]]),
		daily_notification_next_send_at: "2026-02-10T10:00:00.000Z",
		...overrides,
	});
}

describe("processAssetEventsUser", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("continues processing IPO notifications even with zero tracked assets", async () => {
		vi.mocked(loadUserAssets).mockResolvedValue([]);
		vi.mocked(buildAssetEventsContent).mockResolvedValue({
			content: {
				eventsSection: {
					earnings: null,
					dividends: null,
					splits: null,
					ipos: "ACME: IPO tomorrow",
				},
				insiderSection: null,
				analystSection: null,
				filingsLines: null,
				shortInterest: null,
				hasAnyContent: true,
			},
			analystFetchAttempted: false,
			shouldUpdateAnalystMonth: false,
		});
		vi.mocked(processAssetEventsEmailDelivery).mockImplementation(async () => {
			// Delivery layer records success in stats via the real implementation contract.
		});

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
			marketClosureInfo: null,
			sendEmail: vi.fn(async () => ({ success: true })) as never,
			getTelegramSender: vi.fn(() => ({ sender: vi.fn() })) as never,
		});

		expect(stats.skipped).toBe(0);
		expect(stats.emailsFailed).toBe(0);
		expect(vi.mocked(processAssetEventsEmailDelivery)).toHaveBeenCalledOnce();
	});

	it("loads asset events once and delivers on the active channel only", async () => {
		vi.mocked(loadUserAssets).mockResolvedValue([{ symbol: "AAPL" } as never]);
		vi.mocked(buildAssetEventsContent).mockResolvedValue({
			content: {
				eventsSection: null,
				insiderSection: "AAPL: insider",
				analystSection: null,
				filingsLines: null,
				shortInterest: null,
				hasAnyContent: true,
			},
			analystFetchAttempted: false,
			shouldUpdateAnalystMonth: false,
		});
		vi.mocked(processAssetEventsEmailDelivery).mockResolvedValue();
		vi.mocked(processAssetEventsTelegramDelivery).mockResolvedValue();

		const user = makeUser({
			delivery_channel: "telegram",
			telegram_chat_id: 123456,
			prefs: makePrefRows([["daily_notification", "insider", true]]),
		});
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

		await processAssetEventsUser({
			user,
			supabase: supabase as never,
			logger: logger as never,
			currentTime: DateTime.fromISO("2026-02-10T10:00:00.000Z"),
			marketClosureInfo: null,
			sendEmail: vi.fn(async () => ({ success: true })) as never,
			getTelegramSender: vi.fn(() => ({ sender: vi.fn() })) as never,
		});

		expect(vi.mocked(processAssetEventsEmailDelivery)).not.toHaveBeenCalled();
		expect(vi.mocked(processAssetEventsTelegramDelivery)).toHaveBeenCalledOnce();
	});
});
