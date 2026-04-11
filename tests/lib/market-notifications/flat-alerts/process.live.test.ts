/**
 * Live SES delivery test for the 5% flat-price-alert pipeline.
 *
 * Skipped unless `LIVE_API_PROVIDERS` includes `email` (i.e. `npm run
 * test:live:email`). The email-delivery path is mocked in
 * `process.test.ts`; this file leaves the real `createEmailSender` in place
 * so an actual SES `SendEmail` call hits the AWS simulator address used by
 * `createTestEmail()`. Massive providers are still mocked so the test
 * doesn't depend on whether the real API is currently rate-limited.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtendedAssetQuote } from "../../../../src/lib/providers/price-fetcher";
import { isLiveProviderEnabled } from "../../../helpers/live-api";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

vi.mock("../../../../src/lib/providers/massive", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../src/lib/providers/massive")
	>("../../../../src/lib/providers/massive");
	return {
		...actual,
		fetchIntradayBars: vi.fn(async () => ({
			closes: [100, 101, 102, 103, 104, 105],
			timestamps: [null, null, null, null, null, null],
			startTimestamp: null,
			endTimestamp: Date.now(),
		})),
	};
});

vi.mock("../../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../src/lib/providers/price-fetcher")
	>("../../../../src/lib/providers/price-fetcher");
	return {
		...actual,
		fetchSparklines: vi.fn(async (symbols: string[]) => {
			const map = new Map();
			for (const symbol of symbols) {
				map.set(symbol, {
					values: [180, 182, 183, 185, 187, 190, 195],
					ascii: "▁▂▃▄▅▆▇",
				});
			}
			return map;
		}),
	};
});

import { processFlatPriceAlerts } from "../../../../src/lib/market-notifications/flat-alerts/process";

const describeLiveEmail = isLiveProviderEnabled("email")
	? describe
	: describe.skip;

function makeQuote(overrides: Partial<ExtendedAssetQuote>): ExtendedAssetQuote {
	return {
		price: 195.86,
		changePercent: 5.3,
		dayHigh: 196,
		dayLow: 184,
		dayOpen: 184.5,
		prevClose: 186.0,
		timestamp: Math.floor(Date.now() / 1000),
		volume: 1_000_000,
		...overrides,
	};
}

describeLiveEmail("5% flat-price alert delivery via live SES", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("User in New York receives a real SES email when AAPL gaps +5.3% above prev close", {
		timeout: 30_000,
	}, async () => {
		const testUser = await createTestUser({
			trackedAssets: ["AAPL"],
			timezone: "America/New_York",
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(testUser.id);

		const { error: enableError } = await adminClient
			.from("users")
			.update({ price_move_alerts_enabled: true })
			.eq("id", testUser.id);
		expect(enableError).toBeNull();

		// AAPL gapped from $186 prev_close to $195.86 (+5.3%) — past the 5% threshold.
		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.firstOfDayAlerts).toBe(1);
		expect(totals.emailsSent).toBe(1);
		expect(totals.emailsFailed).toBe(0);

		// Verify the notification was logged successfully (no SES error).
		const { data: log, error: logError } = await adminClient
			.from("notification_log")
			.select("id, type, delivery_method, message_delivered, error")
			.eq("user_id", testUser.id)
			.eq("type", "flat_price_alert")
			.maybeSingle();
		expect(logError).toBeNull();
		expect(log).not.toBeNull();
		const row = log as NonNullable<typeof log>;
		expect(row.delivery_method).toBe("email");
		expect(row.message_delivered).toBe(true);
		expect(row.error).toBeNull();
	});
});
