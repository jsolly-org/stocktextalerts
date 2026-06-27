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
import { attachPrefsToUsers } from "../../../src/lib/messaging/load-prefs";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { errorSpy, expectConsoleError } from "../../setup";

// Mock market calendar to avoid real Massive API calls with test keys.
vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

// Mock market-data (a per-call mock lets each test return the prices it expects).
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

vi.mock("../../../src/lib/market-data/session", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/session")>(
		"../../../src/lib/market-data/session",
	);
	return {
		...actual,
		getCurrentMarketSession: getCurrentMarketSessionMock,
	};
});

vi.mock("../../../src/lib/market-data/prices", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/prices")>(
		"../../../src/lib/market-data/prices",
	);
	return {
		...actual,
		fetchAssetPricesWithSessionState: fetchAssetPricesWithSessionStateMock,
	};
});

vi.mock("../../../src/lib/market-data/sparklines", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/sparklines")>(
		"../../../src/lib/market-data/sparklines",
	);
	return {
		...actual,
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

const fetchFinnhubExtrasMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/daily-digest/finnhub-extras", async () => {
	const actual = await vi.importActual<
		typeof import("../../../src/lib/daily-digest/finnhub-extras")
	>("../../../src/lib/daily-digest/finnhub-extras");
	return {
		...actual,
		fetchFinnhubExtras: fetchFinnhubExtrasMock,
	};
});

fetchFinnhubExtrasMock.mockResolvedValue({
	news: new Map(),
	analyst: new Map(),
	insider: new Map(),
	analystFetchSucceeded: false,
});

vi.mock("../../../src/lib/vendors/massive/movers", () => ({
	fetchTopMovers: vi.fn().mockResolvedValue([]),
}));

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
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		const { data: before } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();
		const nextSendAtBefore = before?.daily_digest_next_send_at;

		const stats = await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({
				sender: vi.fn<SmsSender>(async () => ({ success: true })),
			}),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
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
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);
		expect(updateError).toBeNull();
		await setTestUserPrefs(id, [["daily_digest", "rumors", "email", true]]);

		const { data: userRow, error: selectError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(selectError).toBeNull();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		// Realistic AAPL quote during a regular session.
		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["AAPL", { price: 234.18, changePercent: 0.84, prevClose: 232.23 }]]),
			noSessionTrade: new Set<string>(),
		});

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const stats = await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail,
			getSmsSender: () => ({
				sender: smsSender,
			}),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
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
				daily_digest_next_send_at: saturdayInstant.toISO(),
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const stats = await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: saturdayInstant,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
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

	it("SMS-only user with news email preference does not fetch Finnhub news extras.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		fetchFinnhubExtrasMock.mockClear();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			trackedAssets: ["AAPL"],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		await adminClient
			.from("users")
			.update({
				daily_digest_time: 9 * 60,
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);
		await setTestUserPrefs(id, [["daily_digest", "news", "email", true]]);

		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["AAPL", { price: 100, changePercent: 1, prevClose: 99 }]]),
			noSessionTrade: new Set<string>(),
		});

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({
				sender: vi.fn<SmsSender>(async () => ({ success: true })),
			}),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		expect(fetchFinnhubExtrasMock).not.toHaveBeenCalled();
	});

	it("Email-enabled user with news preference fetches Finnhub extras for company news.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		fetchFinnhubExtrasMock.mockClear();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			trackedAssets: ["AAPL"],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		await adminClient
			.from("users")
			.update({
				daily_digest_time: 9 * 60,
				daily_digest_next_send_at: nowIso,
				grok_sends_in_window: 0,
			})
			.eq("id", id);
		await setTestUserPrefs(id, [["daily_digest", "news", "email", true]]);

		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["AAPL", { price: 100, changePercent: 1, prevClose: 99 }]]),
			noSessionTrade: new Set<string>(),
		});

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({
				sender: vi.fn<SmsSender>(async () => ({ success: true })),
			}),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		expect(fetchFinnhubExtrasMock).toHaveBeenCalledWith(
			["AAPL"],
			expect.objectContaining({ includeNews: true }),
		);
	});

	it("Failed SMS delivery does not advance daily_digest_next_send_at.", async () => {
		expectConsoleError("Failed to send Daily Digest SMS part");
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

		await adminClient
			.from("users")
			.update({
				daily_digest_time: 9 * 60,
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);

		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["AAPL", { price: 100, changePercent: 1, prevClose: 99 }]]),
			noSessionTrade: new Set<string>(),
		});

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		const { data: before } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();

		await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({
				sender: vi.fn<SmsSender>(async () => ({
					success: false,
					error: "simulated SMS failure",
				})),
			}),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		const { data: after } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();

		expect(after?.daily_digest_next_send_at).toBe(before?.daily_digest_next_send_at);
	});

	it("Grok limit reached skips Finnhub news fetch even when email news is enabled.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		fetchFinnhubExtrasMock.mockClear();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: true,
			trackedAssets: ["AAPL"],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		await adminClient
			.from("users")
			.update({
				daily_digest_time: 9 * 60,
				daily_digest_next_send_at: nowIso,
				grok_sends_in_window: 999,
				grok_window_start: nowIso,
			})
			.eq("id", id);
		await setTestUserPrefs(id, [["daily_digest", "news", "email", true]]);

		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["AAPL", { price: 100, changePercent: 1, prevClose: 99 }]]),
			noSessionTrade: new Set<string>(),
		});

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({
				sender: vi.fn<SmsSender>(async () => ({ success: true })),
			}),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		expect(fetchFinnhubExtrasMock).not.toHaveBeenCalled();
	});
});
