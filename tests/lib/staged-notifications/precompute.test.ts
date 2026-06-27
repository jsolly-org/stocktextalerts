import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processDailyDigestUser } from "../../../src/lib/daily-digest/process";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import { attachPrefsToUsers } from "../../../src/lib/messaging/load-prefs";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { precomputeDailyDigest } from "../../../src/lib/staged-notifications/precompute";
import { getRealAssetSymbols } from "../../helpers/asset-data";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const {
	dispatchDailyDigestUserMock,
	fetchAssetPricesWithSessionStateMock,
	fetchIntradaySparklinesMock,
	fetchSparklinesMock,
	fetchUpcomingDailyDigestUsersMock,
	getCurrentMarketSessionMock,
} = vi.hoisted(() => ({
	dispatchDailyDigestUserMock: vi.fn(),
	fetchAssetPricesWithSessionStateMock: vi.fn(),
	fetchIntradaySparklinesMock: vi.fn(),
	fetchSparklinesMock: vi.fn(),
	fetchUpcomingDailyDigestUsersMock: vi.fn(),
	getCurrentMarketSessionMock: vi.fn(),
}));

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
	dispatchDailyDigestUser: dispatchDailyDigestUserMock,
}));

vi.mock("../../../src/lib/daily-digest/query-upcoming", () => ({
	fetchUpcomingDailyDigestUsers: fetchUpcomingDailyDigestUsersMock,
}));

vi.mock("../../../src/lib/vendors/price-fetcher", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/vendors/price-fetcher")>(
		"../../../src/lib/vendors/price-fetcher",
	);
	return {
		...actual,
		fetchAssetPricesWithSessionState: fetchAssetPricesWithSessionStateMock,
		fetchIntradaySparklines: fetchIntradaySparklinesMock,
		fetchSparklines: fetchSparklinesMock,
		getCurrentMarketSession: getCurrentMarketSessionMock,
	};
});

describe("A cron job precomputes daily digest content for upcoming users.", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("stores long staged SMS digests as multiple ordered message bodies", async () => {
		const currentTime = DateTime.fromISO("2026-06-01T13:55:00.000Z", { zone: "utc" });
		const scheduledFor = DateTime.fromISO("2026-06-01T14:00:00.000Z", { zone: "utc" });
		const scheduledForIso = scheduledFor.toISO();
		expect(scheduledForIso).toBeTruthy();
		const trackedAssets = getRealAssetSymbols(90);
		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			trackedAssets,
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		await adminClient
			.from("users")
			.update({
				daily_digest_time: 10 * 60,
				daily_digest_next_send_at: scheduledForIso,
			})
			.eq("id", id);
		const { data: userRow, error: userError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(userError).toBeNull();
		expect(userRow).not.toBeNull();
		if (!userRow) throw new Error("expected seeded user row");
		// processDailyDigestUser reads user.prefs (daily_digest prices sms is on by
		// default from createTestUser); attach the freshly-seeded rows.
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		fetchAssetPricesWithSessionStateMock.mockImplementationOnce(async (symbols: string[]) => ({
			prices: new Map(
				symbols.map((symbol, index) => [
					symbol,
					{ price: 100 + index + 0.12, changePercent: 1.23, prevClose: 99 + index },
				]),
			),
			noSessionTrade: new Set<string>(),
		}));
		fetchIntradaySparklinesMock.mockResolvedValueOnce(new Map());
		fetchSparklinesMock.mockResolvedValueOnce(new Map());

		await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			currentTime,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({ sender: vi.fn<SmsSender>(async () => ({ success: true })) }),
			getTelegramSender: () => ({
				sender: vi.fn<TelegramSender>(async () => ({ success: true })),
			}),
			stageOnly: true,
			marketOpen: true,
		});

		const { data: stagedRows, error: stagedError } = await adminClient
			.from("staged_notifications")
			.select("staged_data")
			.eq("user_id", id)
			.eq("notification_type", "daily");
		expect(stagedError).toBeNull();
		expect(stagedRows).toHaveLength(1);
		const stagedData = stagedRows?.[0]?.staged_data as {
			sms?: { message?: string; messages?: string[] } | null;
		};

		expect(stagedData.sms?.messages).toBeDefined();
		expect(stagedData.sms?.messages?.length).toBeGreaterThan(1);
		expect(stagedData.sms).not.toHaveProperty("message");
	});

	it("leaves market-closure classification to each user's scheduled instant", async () => {
		const currentTime = DateTime.fromISO("2026-03-22T03:59:50.000Z", {
			zone: "utc",
		});
		const currentTimeIso = currentTime.toISO();
		if (!currentTimeIso) {
			throw new Error("Expected valid currentTime ISO string");
		}

		fetchUpcomingDailyDigestUsersMock.mockResolvedValue([
			{ id: "10000000-0000-4000-a000-000000000001" },
			{ id: "10000000-0000-4000-a000-000000000002" },
		]);
		getCurrentMarketSessionMock.mockResolvedValue("closed");
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});

		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await precomputeDailyDigest({
			supabase: {} as never,
			logger: logger as never,
			currentTime,
		});

		expect(dispatchDailyDigestUserMock).toHaveBeenCalledTimes(2);

		for (const [args] of dispatchDailyDigestUserMock.mock.calls) {
			expect(args).toMatchObject({
				currentTimeIso,
				precompute: true,
				marketOpen: false,
			});
			expect(args).not.toHaveProperty("marketClosureInfo");
		}
	});

	it("uses scheduler-provided marketOpen without calling Massive market status again", async () => {
		const currentTime = DateTime.fromISO("2026-06-01T13:55:00.000Z", { zone: "utc" });
		fetchUpcomingDailyDigestUsersMock.mockResolvedValue([
			{ id: "10000000-0000-4000-a000-000000000004" },
		]);
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});

		await precomputeDailyDigest({
			supabase: {} as never,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			currentTime,
			marketOpen: true,
		});

		expect(getCurrentMarketSessionMock).not.toHaveBeenCalled();
		expect(dispatchDailyDigestUserMock).toHaveBeenCalledWith(
			expect.objectContaining({ marketOpen: true, precompute: true }),
		);
	});
});
