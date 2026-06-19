import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssetEventsContentForChannels } from "../../../src/lib/asset-events/content";
import {
	processAssetEventsEmailDelivery,
	processAssetEventsSmsDelivery,
} from "../../../src/lib/asset-events/delivery";
import { processAssetEventsUser } from "../../../src/lib/asset-events/process";
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
		buildAssetEventsContentForChannels: vi.fn(),
	};
});

vi.mock("../../../src/lib/asset-events/delivery", async () => {
	const actual = await vi.importActual("../../../src/lib/asset-events/delivery");
	return {
		...actual,
		processAssetEventsEmailDelivery: vi.fn(),
		processAssetEventsSmsDelivery: vi.fn(),
		processAssetEventsTelegramDelivery: vi.fn(),
	};
});

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/lib/asset-events/schedule-state", () => ({
	shouldAdvanceAssetEventsSchedule: vi.fn().mockResolvedValue(true),
}));

import type { UserRecord } from "../../../src/lib/messaging/types";
import { makeUserRecord } from "../../helpers/user-record-fixture";

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
	return makeUserRecord({
		sms_opted_out: true,
		asset_events_include_ipo_email: true,
		asset_events_next_send_at: "2026-02-10T10:00:00.000Z",
		...overrides,
	});
}

describe("processAssetEventsUser", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("continues processing IPO notifications even with zero tracked assets", async () => {
		vi.mocked(loadUserAssets).mockResolvedValue([]);
		vi.mocked(buildAssetEventsContentForChannels).mockResolvedValue({
			email: {
				eventsSection: {
					earnings: null,
					dividends: null,
					splits: null,
					ipos: "ACME: IPO tomorrow",
				},
				insiderSection: null,
				analystSection: null,
				hasAnyContent: true,
			},
			sms: null,
			telegram: null,
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
			getSmsSender: vi.fn(() => ({ sender: "+15555550123" })) as never,
			getTelegramSender: vi.fn(() => ({ sender: vi.fn() })) as never,
		});

		expect(stats.skipped).toBe(0);
		expect(stats.emailsFailed).toBe(0);
		expect(vi.mocked(processAssetEventsEmailDelivery)).toHaveBeenCalledOnce();
	});

	it("loads asset events once when both email and SMS are enabled", async () => {
		vi.mocked(loadUserAssets).mockResolvedValue([{ symbol: "AAPL" } as never]);
		vi.mocked(buildAssetEventsContentForChannels).mockResolvedValue({
			email: {
				eventsSection: null,
				insiderSection: "AAPL: insider",
				analystSection: null,
				hasAnyContent: true,
			},
			sms: {
				eventsSection: null,
				insiderSection: "AAPL: insider",
				analystSection: null,
				hasAnyContent: true,
			},
			telegram: null,
			analystFetchAttempted: false,
			shouldUpdateAnalystMonth: false,
		});
		vi.mocked(processAssetEventsEmailDelivery).mockResolvedValue();
		vi.mocked(processAssetEventsSmsDelivery).mockResolvedValue();

		const user = makeUser({
			sms_opted_out: false,
			sms_notifications_enabled: true,
			phone_verified: true,
			asset_events_include_insider_email: true,
			asset_events_include_insider_sms: true,
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
			getSmsSender: vi.fn(() => ({ sender: "+15555550123" })) as never,
			getTelegramSender: vi.fn(() => ({ sender: vi.fn() })) as never,
		});

		expect(vi.mocked(processAssetEventsEmailDelivery)).toHaveBeenCalledOnce();
		expect(vi.mocked(processAssetEventsSmsDelivery)).toHaveBeenCalledOnce();
	});
});
