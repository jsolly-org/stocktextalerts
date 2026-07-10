/**
 * Scenario-based tests for daily digest process.
 *
 * Covers real-world cases: user with no assets and no digest options is skipped
 * and next_send_at is advanced; email-enabled user with a news preference
 * fetches Massive company news for Grok; Grok limit reached skips that fetch.
 */
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { processDailyDigestUser } from "../../../src/lib/daily-digest/process";
import { rootLogger } from "../../../src/lib/logging";
import { attachPrefsToUsers } from "../../../src/lib/messaging/load-prefs";
import type { EmailSender, TelegramSender } from "../../../src/lib/messaging/types";
import type { UserRecord } from "../../../src/lib/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

// Mock market calendar to avoid real Massive API calls with test keys.
vi.mock("../../../src/lib/time/market/calendar", () => ({
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

const fetchDigestNewsForGrokMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/daily-digest/digest-extras", async () => {
	const actual = await vi.importActual<
		typeof import("../../../src/lib/daily-digest/digest-extras")
	>("../../../src/lib/daily-digest/digest-extras");
	return {
		...actual,
		fetchDigestNewsForGrok: fetchDigestNewsForGrokMock,
	};
});

fetchDigestNewsForGrokMock.mockResolvedValue(new Map());

vi.mock("../../../src/lib/market-data/movers", () => ({
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
				daily_notification_time: nineAmLocalMinutes,
				daily_notification_next_send_at: nowIso,
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
			.select("daily_notification_next_send_at")
			.eq("id", id)
			.single();
		const nextSendAtBefore = before?.daily_notification_next_send_at;

		const stats = await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		expect(stats.skipped).toBe(1);
		expect(stats.emailsSent).toBe(0);

		const { data: after } = await adminClient
			.from("users")
			.select("daily_notification_next_send_at")
			.eq("id", id)
			.single();
		expect(after?.daily_notification_next_send_at).not.toBeNull();
		expect(after?.daily_notification_next_send_at).not.toBe(nextSendAtBefore);
	});

	it("Email-enabled user with news preference fetches digest extras for company news.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		fetchDigestNewsForGrokMock.mockClear();

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
				daily_notification_time: 9 * 60,
				daily_notification_next_send_at: nowIso,
				grok_sends_in_window: 0,
			})
			.eq("id", id);
		await setTestUserPrefs(id, [["daily_notification", "news", "email", true]]);

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
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		expect(fetchDigestNewsForGrokMock).toHaveBeenCalledWith(["AAPL"]);
	});

	it("Grok limit reached skips provider news fetch even when email news is enabled.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		fetchDigestNewsForGrokMock.mockClear();

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
				daily_notification_time: 9 * 60,
				daily_notification_next_send_at: nowIso,
				grok_sends_in_window: 999,
				grok_window_start: nowIso,
			})
			.eq("id", id);
		await setTestUserPrefs(id, [["daily_notification", "news", "email", true]]);

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
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
		});

		expect(fetchDigestNewsForGrokMock).not.toHaveBeenCalled();
	});
});
