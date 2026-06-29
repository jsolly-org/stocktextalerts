import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import type { ExtendedAssetQuote } from "../../../src/lib/market-data-types";
import { reserveFlatPriceAlert } from "../../../src/lib/market-notifications/flat-alerts/state";
import { processPriceAlerts } from "../../../src/lib/market-notifications/process";
import { reserveCooldownSlot } from "../../../src/lib/market-notifications/users";
import { adminClient } from "../../helpers/test-env";
import {
	createTestUser,
	generateUniquePhoneNumber,
	setTestUserPrefs,
} from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const mocks = vi.hoisted(() => ({
	computeAnomalyScore: vi.fn(),
	fetchExtendedQuotes: vi.fn(),
	sendEmail: vi.fn(),
	sendSms: vi.fn(),
}));

vi.mock("../../../src/lib/market-notifications/anomaly-detection", async () => {
	const actual = await vi.importActual<
		typeof import("../../../src/lib/market-notifications/anomaly-detection")
	>("../../../src/lib/market-notifications/anomaly-detection");
	return {
		...actual,
		computeAnomalyScore: mocks.computeAnomalyScore,
	};
});

vi.mock("../../../src/lib/market-data/prices", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/prices")>(
		"../../../src/lib/market-data/prices",
	);
	return {
		...actual,
		fetchExtendedQuotes: mocks.fetchExtendedQuotes,
	};
});

vi.mock("../../../src/lib/messaging/email/utils", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/messaging/email/utils")>(
		"../../../src/lib/messaging/email/utils",
	);
	return {
		...actual,
		createEmailSender: () => mocks.sendEmail,
	};
});

vi.mock("../../../src/lib/messaging/sms/sender-factory", () => ({
	createSmsSenderFactory: () => () => ({ sender: mocks.sendSms }),
}));

function failingRpcClient(message: string): SupabaseAdminClient {
	return {
		rpc: async () => ({
			data: null,
			error: {
				code: "42501",
				message,
			},
		}),
	} as unknown as SupabaseAdminClient;
}

function makeQuote(overrides: Partial<ExtendedAssetQuote> = {}): ExtendedAssetQuote {
	return {
		price: 120,
		changePercent: 20,
		dayHigh: 121,
		dayLow: 99,
		dayOpen: 100,
		prevClose: 100,
		timestamp: Math.floor(Date.now() / 1000),
		volume: 2_000_000,
		...overrides,
	};
}

async function countPriceAlertLogs(userId: string): Promise<number> {
	const { count, error } = await adminClient
		.from("notification_log")
		.select("*", { count: "exact", head: true })
		.eq("user_id", userId)
		.eq("type", "price_alert");
	if (error) throw new Error(`Count query failed: ${error.message}`);
	return count ?? 0;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.computeAnomalyScore.mockReturnValue({
		score: 100,
		signals: [],
		summary: "test anomaly",
	});
	mocks.fetchExtendedQuotes.mockResolvedValue(
		new Map([
			["AAPL", makeQuote()],
			["SPY", makeQuote({ price: 500, changePercent: 0, prevClose: 500 })],
		]),
	);
	mocks.sendEmail.mockResolvedValue({ success: true });
	mocks.sendSms.mockResolvedValue({ success: true });
});

describe("Notification reserve RPC errors", () => {
	it("Flat price alerts fail closed when delivery-state reservation errors", async () => {
		const { expectConsoleError } = await import("../../setup");
		expectConsoleError("Failed to reserve flat price alert slot");

		await expect(
			reserveFlatPriceAlert(
				failingRpcClient("permission denied for function reserve_flat_price_alert"),
				{
					userId: "58a22d86-a756-4f1e-8d6b-913f4f0b5c91",
					symbol: "AAPL",
					baselinePrice: 186,
					newPrice: 195.86,
					thresholdPercent: 5,
				},
			),
		).resolves.toBe(false);
	});

	it("Market price alerts fail closed when cooldown reservation errors", async () => {
		const { expectConsoleError } = await import("../../setup");
		expectConsoleError("Failed to reserve price alert trading-day slot");

		await expect(
			reserveCooldownSlot(
				failingRpcClient("permission denied for function reserve_market_asset_price_alert_slot"),
				"58a22d86-a756-4f1e-8d6b-913f4f0b5c91",
				"AAPL",
				5.1,
				10.25,
			),
		).resolves.toBe(false);
	});

	it("Market price alert reserve permission error skips delivery and notification logging", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_asset_price_alerts_enabled: true,
				email_notifications_enabled: true,
				sms_notifications_enabled: true,
				phone_country_code: "+1",
				phone_number: generateUniquePhoneNumber(),
				phone_verified: true,
				sms_opted_out: false,
			})
			.eq("id", testUser.id);
		if (updateError) throw new Error(`Failed to enable price alerts: ${updateError.message}`);
		// Per-option market_asset_price_alerts facets live in notification_preferences.
		await setTestUserPrefs(testUser.id, [
			["market_asset_price_alerts", "", "email", true],
			["market_asset_price_alerts", "", "sms", true],
		]);

		const failingSupabase = new Proxy(adminClient, {
			get(target, prop, receiver) {
				if (prop === "rpc") {
					return (fn: string, args: unknown) => {
						if (fn === "reserve_market_asset_price_alert_slot") {
							return Promise.resolve({
								data: null,
								error: {
									code: "42501",
									message: "permission denied for function reserve_market_asset_price_alert_slot",
								},
							});
						}
						return Reflect.get(target, prop, receiver).call(target, fn, args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const { expectConsoleError } = await import("../../setup");
		expectConsoleError("Failed to reserve price alert trading-day slot");

		const { totals } = await processPriceAlerts({
			supabase: failingSupabase as typeof adminClient,
			marketSession: "regular",
		});

		expect(totals.cooldownSkips).toBe(1);
		expect(totals.alertsTriggered).toBe(0);
		expect(totals.emailsSent).toBe(0);
		expect(totals.smsSent).toBe(0);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(mocks.sendSms).not.toHaveBeenCalled();
		expect(await countPriceAlertLogs(testUser.id)).toBe(0);
	});
});
