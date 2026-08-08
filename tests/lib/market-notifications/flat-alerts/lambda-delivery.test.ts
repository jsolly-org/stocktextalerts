/**
 * Lambda delivery_channel: flat alerts wake asset-buyer and skip email/Telegram
 * and notification_log (delivery_method enum is email|telegram only).
 */
import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import { deliverFlatPriceAlert } from "../../../../src/lib/market-notifications/flat-alerts/delivery";
import type { FlatPriceAlertUser } from "../../../../src/lib/market-notifications/flat-alerts/users";
import { createLogoCache } from "../../../../src/lib/messaging/logo-fetcher";
import type {
	ChannelDeliveryStats,
	DeliveryResult,
	ExtendedAssetQuote,
} from "../../../../src/lib/types";
import { makePrefRows } from "../../../helpers/user-record-fixture";

const wakeupAssetBuyerFromFlatAlert = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../../src/lib/market-notifications/flat-alerts/asset-buyer-wakeup", () => ({
	wakeupAssetBuyerFromFlatAlert,
}));

type RecordedInsert = { table: string; row: Record<string, unknown> };

function makeSupabaseMock(): { client: AppSupabaseClient; inserts: RecordedInsert[] } {
	const inserts: RecordedInsert[] = [];
	const client = {
		from(table: string) {
			return {
				insert: async (row: Record<string, unknown>) => {
					inserts.push({ table, row });
					return { error: null };
				},
			};
		},
		rpc: async () => ({ data: true, error: null }),
	} as unknown as AppSupabaseClient;
	return { client, inserts };
}

function makeStats(): ChannelDeliveryStats {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};
}

describe("deliverFlatPriceAlert lambda channel", () => {
	it("invokes wakeup, skips email/Telegram and notification_log", async () => {
		wakeupAssetBuyerFromFlatAlert.mockClear();
		const { client, inserts } = makeSupabaseMock();
		const sendEmail = vi.fn(async (): Promise<DeliveryResult> => ({ success: true }));
		const sendTelegram = vi.fn(async (): Promise<DeliveryResult> => ({ success: true }));
		const stats = makeStats();

		const user: FlatPriceAlertUser = {
			id: "00000000-0000-0000-0000-000000000099",
			email: "stock-buyer@internal.stocktextalerts",
			delivery_channel: "lambda",
			use_24_hour_time: false,
			telegram_chat_id: null,
			price_move_why_window_start: null,
			price_move_why_sends_in_window: 0,
			prefs: makePrefRows([["price_move_alerts", "", true]]),
		};

		const delivered = await deliverFlatPriceAlert({
			user,
			symbol: "NVDA",
			companyName: "NVIDIA",
			quote: {
				price: 120,
				prevClose: 100,
				changePercent: 20,
				dayOpen: 105,
				timestamp: 0,
			} as ExtendedAssetQuote,
			baseline: 100,
			triggerPercent: 20,
			isReTrigger: false,
			isAcceleration: false,
			lastNotificationAt: null,
			nowMs: Date.now(),
			intraday: null,
			sevenDaySparkline: null,
			iconUrl: null,
			iconBase64: null,
			supabase: client,
			sendEmail,
			sendTelegram,
			logoCache: createLogoCache(),
			stats,
		});

		expect(delivered).toBe(true);
		expect(wakeupAssetBuyerFromFlatAlert).toHaveBeenCalledWith({
			symbol: "NVDA",
			triggerPercent: 20,
			isAcceleration: false,
		});
		expect(sendEmail).not.toHaveBeenCalled();
		expect(sendTelegram).not.toHaveBeenCalled();
		expect(inserts.some((i) => i.table === "notification_log")).toBe(false);
		expect(stats.emailsSent).toBe(0);
		expect(stats.telegramSent).toBe(0);
	});

	it("skips wakeup when price_move_alerts facet is off", async () => {
		wakeupAssetBuyerFromFlatAlert.mockClear();
		const { client } = makeSupabaseMock();
		const user: FlatPriceAlertUser = {
			id: "00000000-0000-0000-0000-000000000099",
			email: "stock-buyer@internal.stocktextalerts",
			delivery_channel: "lambda",
			use_24_hour_time: false,
			telegram_chat_id: null,
			price_move_why_window_start: null,
			price_move_why_sends_in_window: 0,
			prefs: makePrefRows([["price_move_alerts", "", false]]),
		};

		const delivered = await deliverFlatPriceAlert({
			user,
			symbol: "MSFT",
			companyName: "Microsoft",
			quote: {
				price: 420,
				prevClose: 400,
				changePercent: 5,
				dayOpen: 401,
				timestamp: 0,
			} as ExtendedAssetQuote,
			baseline: 400,
			triggerPercent: 5,
			isReTrigger: false,
			isAcceleration: false,
			lastNotificationAt: null,
			nowMs: Date.now(),
			intraday: null,
			sevenDaySparkline: null,
			iconUrl: null,
			iconBase64: null,
			supabase: client,
			sendEmail: vi.fn(async (): Promise<DeliveryResult> => ({ success: true })),
			logoCache: createLogoCache(),
			stats: makeStats(),
		});

		expect(delivered).toBe(false);
		expect(wakeupAssetBuyerFromFlatAlert).not.toHaveBeenCalled();
	});
});
