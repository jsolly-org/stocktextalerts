/**
 * Scenario-based tests for daily digest process.
 *
 * Covers real-world cases: user with no assets and no digest options is skipped
 * and next_send_at is advanced; user who disabled email still receives price
 * summary via SMS only; weekend digest pulls prev-day prices without firing
 * spurious error logs.
 */
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { processDailyDigestUser } from "../../../src/lib/daily-digest/process";
import { rootLogger } from "../../../src/lib/logging";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { errorSpy } from "../../setup";

// Mock market calendar to avoid real Massive API calls with test keys.
vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

// Mock price-fetcher (a per-call mock lets each test return the prices it expects).
// Mocks must be created via vi.hoisted so the vi.mock factory below — which is
// hoisted to the top of the module — can reference them.
const {
	fetchAssetPricesWithSessionStateMock,
	getCurrentMarketSessionMock,
	fetchIntradaySparklinesMock,
	fetchSparklinesMock,
} = vi.hoisted(() => ({
	fetchAssetPricesWithSessionStateMock: vi.fn(),
	getCurrentMarketSessionMock: vi.fn(),
	fetchIntradaySparklinesMock: vi.fn(),
	fetchSparklinesMock: vi.fn(),
}));

vi.mock("../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/providers/price-fetcher")>(
		"../../../src/lib/providers/price-fetcher",
	);
	return {
		...actual,
		fetchAssetPricesWithSessionState: fetchAssetPricesWithSessionStateMock,
		getCurrentMarketSession: getCurrentMarketSessionMock,
		fetchIntradaySparklines: fetchIntradaySparklinesMock,
		fetchSparklines: fetchSparklinesMock,
	};
});

// Default stubs — individual tests override as needed.
fetchAssetPricesWithSessionStateMock.mockResolvedValue({
	prices: new Map(),
	noSessionTrade: new Set<string>(),
});
getCurrentMarketSessionMock.mockResolvedValue("regular");
fetchIntradaySparklinesMock.mockResolvedValue(new Map());
fetchSparklinesMock.mockResolvedValue(new Map());

// Mock Massive top-movers to avoid the live call.
vi.mock("../../../src/lib/providers/massive", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/providers/massive")>(
		"../../../src/lib/providers/massive",
	);
	return {
		...actual,
		fetchTopMovers: vi.fn().mockResolvedValue([]),
	};
});

describe("Daily digest process scenarios", () => {
	it("User with no tracked assets and no digest or asset-events options is skipped and next_send_at is advanced.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			trackedAssets: [],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		// Set daily_digest_time so that after skip, updateUserDailyDigestNextSendAt computes a future next_send_at (9 AM local).
		const nineAmLocalMinutes = 9 * 60;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: nineAmLocalMinutes,
				daily_digest_include_news_email: false,
				daily_digest_include_rumors_email: false,
				asset_events_include_calendar_email: false,
				asset_events_include_calendar_sms: false,
				asset_events_include_ipo_email: false,
				asset_events_include_ipo_sms: false,
				asset_events_include_analyst_email: false,
				asset_events_include_analyst_sms: false,
				asset_events_include_insider_email: false,
				asset_events_include_insider_sms: false,
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: userRow, error: selectError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(selectError).toBeNull();
		expect(userRow).not.toBeNull();

		const { data: before } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();
		const nextSendAtBefore = before?.daily_digest_next_send_at;

		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({
				sender: vi.fn<SmsSender>(async () => ({ success: true })),
			}),
		});

		expect(stats.skipped).toBe(1);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(0);

		const { data: after } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();
		expect(after?.daily_digest_next_send_at).not.toBeNull();
		expect(after?.daily_digest_next_send_at).not.toBe(nextSendAtBefore);
	});

	it("User who disabled email but has SMS enabled receives price summary via SMS only.", async () => {
		// Grok content (news/rumors) is email-only by design; with email disabled,
		// SMS contains only tracked asset prices.
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			trackedAssets: ["AAPL"],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		const nineAmLocalMinutes = 9 * 60;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: nineAmLocalMinutes,
				daily_digest_include_news_email: false,
				daily_digest_include_rumors_email: true,
				asset_events_include_calendar_email: false,
				asset_events_include_calendar_sms: false,
				asset_events_include_ipo_email: false,
				asset_events_include_ipo_sms: false,
				asset_events_include_analyst_email: false,
				asset_events_include_analyst_sms: false,
				asset_events_include_insider_email: false,
				asset_events_include_insider_sms: false,
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: userRow, error: selectError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(selectError).toBeNull();
		expect(userRow).not.toBeNull();

		// Realistic AAPL quote during a regular session.
		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["AAPL", { price: 234.18, changePercent: 0.84, prevClose: 232.23 }]]),
			noSessionTrade: new Set<string>(),
		});

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail,
			getSmsSender: () => ({
				sender: smsSender,
			}),
		});

		expect(stats.skipped).toBe(0);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(1);
		expect(stats.emailsFailed).toBe(0);
		expect(stats.smsFailed).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(smsSender).toHaveBeenCalledTimes(1);
	});

	it("Saturday digest for a user with 10 blue-chip tickers delivers SMS with prev-day prices and fires no error log.", async () => {
		// Regression for the alarm that fired at 22:29 UTC on 2026-05-16
		// (Saturday): every ticker came back null because the closed-session
		// price path discarded "no_session_trade" entries. After the
		// price-fetcher fix, the data-layer returns prev-day bars and the
		// digest renders without any logger.error firing.
		const saturdayInstant = DateTime.fromISO("2026-05-16T18:30:00", {
			zone: "America/New_York",
		}).toUTC();

		getCurrentMarketSessionMock.mockResolvedValueOnce("closed");
		fetchSparklinesMock.mockImplementationOnce(
			async (symbols: string[]) =>
				new Map(
					symbols.map((s) => [
						s,
						{ values: [1, 2, 3, 5, 7, 5, 3], ascii: "▁▂▃▅▇▅▃", window: "7-trading-days" },
					]),
				),
		);

		const errorCallsBefore = errorSpy.mock.calls.length;

		const blueChips = ["NVDA", "AMZN", "BA", "MSTR", "GOOGL", "UNH", "JPM", "PG", "FIG", "TSLA"];
		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map(
				blueChips.map((s) => [s, { price: 200.12, changePercent: 0, prevClose: 200.12 }]),
			),
			noSessionTrade: new Set<string>(),
		});

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			trackedAssets: blueChips,
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		const sixThirtyPmLocalMinutes = 18 * 60 + 30;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: sixThirtyPmLocalMinutes,
				daily_digest_include_prices_email: true,
				daily_digest_include_prices_sms: true,
				daily_digest_include_news_email: false,
				daily_digest_include_rumors_email: false,
				asset_events_include_calendar_email: false,
				asset_events_include_calendar_sms: false,
				asset_events_include_ipo_email: false,
				asset_events_include_ipo_sms: false,
				asset_events_include_analyst_email: false,
				asset_events_include_analyst_sms: false,
				asset_events_include_insider_email: false,
				asset_events_include_insider_sms: false,
				daily_digest_next_send_at: saturdayInstant.toISO(),
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		expect(userRow).not.toBeNull();

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: saturdayInstant,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		expect(stats.skipped).toBe(0);
		expect(stats.smsSent).toBe(1);
		expect(stats.smsFailed).toBe(0);
		expect(smsSender).toHaveBeenCalledTimes(1);
		// Regression guard for the original alarm: no new error logs during the
		// weekend digest. Asserting on the global errorSpy delta is the direct
		// check; relying on the implicit setup.ts afterEach is fragile if the
		// test ever moves to a runner config that doesn't load setup.ts.
		expect(errorSpy.mock.calls.length).toBe(errorCallsBefore);
	});
});
