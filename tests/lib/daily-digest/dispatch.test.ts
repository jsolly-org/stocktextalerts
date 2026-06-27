import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsoleError } from "../../setup";

const processDailyDigestUserMock = vi.fn();

vi.mock("../../../src/lib/daily-digest/process", () => ({
	processDailyDigestUser: processDailyDigestUserMock,
}));

vi.mock("../../../src/lib/messaging/email/utils", () => ({
	createEmailSender: () => vi.fn(),
}));

vi.mock("../../../src/lib/messaging/sms/sender-factory", () => ({
	createSmsSenderFactory: () => () => ({ sender: "+15555550123" }),
}));

const mockSupabaseUser = {
	id: "00000000-0000-0000-0000-000000000123",
	email: "test@example.com",
	phone_country_code: null,
	phone_number: null,
	phone_verified: false,
	timezone: "America/New_York",
	use_24_hour_time: false,
	daily_digest_time: 540,
	daily_digest_next_send_at: null,
	email_notifications_enabled: true,
	sms_notifications_enabled: false,
	sms_opted_out: false,
	asset_events_next_send_at: null,
	asset_events_last_analyst_sent_month: null,
	last_grok_rumors_at: null,
	grok_window_start: null,
	grok_sends_in_window: 0,
};

const mockMaybeSingle = vi.fn();
// loadPrefsByUser reads notification_preferences via from(...).select(...).in(...);
// dispatch attaches the rows to the user and hands off to (mocked) processDailyDigestUser.
const mockPrefsIn = vi.fn(async () => ({ data: [], error: null }));
const mockFrom = vi.fn((table: string) =>
	table === "notification_preferences"
		? { select: () => ({ in: mockPrefsIn }) }
		: { select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) },
);

vi.mock("../../../src/lib/db/supabase", () => ({
	createSupabaseAdminClient: () => ({ from: mockFrom }),
}));

describe("Daily digest dispatch (direct function call)", () => {
	beforeEach(() => {
		processDailyDigestUserMock.mockReset();
		mockMaybeSingle.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("calls processDailyDigestUser and returns stats on success", async () => {
		const { dispatchDailyDigestUser } = await import("../../../src/lib/daily-digest/dispatch");

		mockMaybeSingle.mockResolvedValueOnce({
			data: mockSupabaseUser,
			error: null,
		});
		processDailyDigestUserMock.mockResolvedValueOnce({
			skipped: 0,
			logFailures: 0,
			emailsSent: 1,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
			precompute: true,
			marketClosureInfo: { reason: "holiday", holidayName: "Presidents' Day" },
		});

		expect(stats).toEqual({
			skipped: 0,
			logFailures: 0,
			emailsSent: 1,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
		expect(processDailyDigestUserMock).toHaveBeenCalledTimes(1);
		expect(processDailyDigestUserMock).toHaveBeenCalledWith(
			expect.objectContaining({
				stageOnly: true,
				marketClosureInfo: {
					reason: "holiday",
					holidayName: "Presidents' Day",
				},
			}),
		);
	});

	it("returns skipped stats when user is not found", async () => {
		expectConsoleError("User not found for daily dispatch");
		const { dispatchDailyDigestUser } = await import("../../../src/lib/daily-digest/dispatch");

		mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
		});

		expect(stats).toEqual({
			skipped: 1,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			telegramSent: 0,
			telegramFailed: 0,
		});
		expect(processDailyDigestUserMock).not.toHaveBeenCalled();
	});

	it("returns skipped stats when Supabase fetch fails", async () => {
		expectConsoleError("Failed to fetch user for daily dispatch");
		const { dispatchDailyDigestUser } = await import("../../../src/lib/daily-digest/dispatch");

		mockMaybeSingle.mockResolvedValueOnce({
			data: null,
			error: { message: "db error" },
		});

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
		});

		expect(stats).toEqual({
			skipped: 1,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			telegramSent: 0,
			telegramFailed: 0,
		});
	});

	it("returns skipped stats when processDailyDigestUser throws", async () => {
		expectConsoleError("Daily digest dispatch failed");
		const { dispatchDailyDigestUser } = await import("../../../src/lib/daily-digest/dispatch");

		mockMaybeSingle.mockResolvedValueOnce({
			data: mockSupabaseUser,
			error: null,
		});
		processDailyDigestUserMock.mockRejectedValueOnce(new Error("processing failed"));

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
		});

		expect(stats).toEqual({
			skipped: 1,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			telegramSent: 0,
			telegramFailed: 0,
		});
	});
});
