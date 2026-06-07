import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateUserMarketScheduledNextSendAt } from "../../../../src/lib/market-notifications/scheduled/next-send-at";
import { processMarketScheduledUser } from "../../../../src/lib/market-notifications/scheduled/process";
import { shouldAdvanceMarketScheduledSchedule } from "../../../../src/lib/market-notifications/scheduled/schedule-state";
import { makeUserRecord } from "../../../helpers/user-record-fixture";

vi.mock("../../../../src/lib/market-notifications/scheduled/next-send-at", () => ({
	updateUserMarketScheduledNextSendAt: vi.fn(),
}));

vi.mock("../../../../src/lib/market-notifications/scheduled/schedule-state", () => ({
	shouldAdvanceMarketScheduledSchedule: vi.fn(),
}));

vi.mock("../../../../src/lib/market-notifications/scheduled/delivery", () => ({
	processMarketScheduledEmailDelivery: vi.fn(),
	processMarketScheduledSmsDelivery: vi.fn(),
}));

vi.mock("../../../../src/lib/schedule/helpers", async () => {
	const actual = await vi.importActual("../../../../src/lib/schedule/helpers");
	return {
		...actual,
		loadUserAssets: vi.fn(async () => [{ symbol: "AAPL", name: "Apple" }]),
	};
});

vi.mock("../../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual("../../../../src/lib/providers/price-fetcher");
	return {
		...actual,
		fetchIntradaySparklines: vi.fn(async () => new Map()),
	};
});

vi.mock("../../../../src/lib/messaging/logo-fetcher", () => ({
	safePrefetchLogos: vi.fn(async () => ({ getLogoHtml: () => undefined })),
}));

vi.mock("../../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn(async () => null),
}));

import {
	processMarketScheduledEmailDelivery,
	processMarketScheduledSmsDelivery,
} from "../../../../src/lib/market-notifications/scheduled/delivery";

describe("processMarketScheduledUser schedule advancement", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not advance next_send_at when delivery channels are still retryable", async () => {
		vi.mocked(shouldAdvanceMarketScheduledSchedule).mockResolvedValue(false);
		vi.mocked(processMarketScheduledEmailDelivery).mockResolvedValue();

		const user = makeUserRecord({
			market_scheduled_asset_price_next_send_at: "2026-06-07T13:30:00.000Z",
			market_scheduled_asset_price_include_email: true,
			email_notifications_enabled: true,
		});

		await processMarketScheduledUser({
			user,
			supabase: {} as never,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			currentTime: DateTime.fromISO("2026-06-07T13:35:00.000Z"),
			sendEmail: vi.fn() as never,
			getSmsSender: vi.fn() as never,
			priceMap: new Map([["AAPL", { price: 100, changePercent: 1, prevClose: 99 } as never]]),
			marketSession: "regular",
		});

		expect(updateUserMarketScheduledNextSendAt).not.toHaveBeenCalled();
	});

	it("advances next_send_at when all required channels are terminal", async () => {
		vi.mocked(shouldAdvanceMarketScheduledSchedule).mockResolvedValue(true);
		vi.mocked(processMarketScheduledEmailDelivery).mockResolvedValue();
		vi.mocked(processMarketScheduledSmsDelivery).mockResolvedValue();

		const user = makeUserRecord({
			market_scheduled_asset_price_next_send_at: "2026-06-07T13:30:00.000Z",
			market_scheduled_asset_price_include_email: true,
			market_scheduled_asset_price_include_sms: true,
			email_notifications_enabled: true,
			sms_notifications_enabled: true,
			phone_verified: true,
		});

		await processMarketScheduledUser({
			user,
			supabase: {} as never,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			currentTime: DateTime.fromISO("2026-06-07T13:35:00.000Z"),
			sendEmail: vi.fn() as never,
			getSmsSender: vi.fn(() => ({ sender: vi.fn() })) as never,
			priceMap: new Map([["AAPL", { price: 100, changePercent: 1, prevClose: 99 } as never]]),
			marketSession: "regular",
		});

		expect(updateUserMarketScheduledNextSendAt).toHaveBeenCalledOnce();
	});
});
