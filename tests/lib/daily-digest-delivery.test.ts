import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SMS_UCS2_SEGMENT_SIZE } from "../../src/lib/constants";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsMessage,
	formatDailyDigestSmsMessages,
	processDailyDigestSmsDelivery,
} from "../../src/lib/daily-digest/delivery";
import type { Logger } from "../../src/lib/logging";
import type { SmsExtras } from "../../src/lib/messaging/sms/delivery";
import {
	finalizeSmsBodyForUcs2Segments,
	findDailyDigestProtectedSpans,
	spanStraddlesBoundary,
} from "../../src/lib/messaging/sms/segment-utils";
import type { SmsSender } from "../../src/lib/messaging/sms/twilio-utils";
import type { SparklineData } from "../../src/lib/messaging/sparkline";
import type { UserAssetRow, UserRecord } from "../../src/lib/messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../../src/lib/schedule/helpers";
import type { AssetPriceMap } from "../../src/lib/vendors/price-fetcher";
import { assertIsoDateString, assertMinuteOfDay } from "../../src/lib/types";
import { makePrefRows } from "../helpers/user-record-fixture";

describe("Daily digest email prices", () => {
	const user = { id: "user-1", email: "test@example.com" };
	const userAssets: [UserAssetRow, UserAssetRow] = [
		{ symbol: "AAPL", name: "Apple Inc" },
		{ symbol: "MSFT", name: "Microsoft Corp" },
	];
	const extras: SmsExtras = {
		news: null,
		rumors: null,
		analyst: null,
		insider: null,
	};

	const sparklineData: SparklineData = {
		values: [1, 2, 3, 5, 7, 5, 3],
		ascii: "▁▂▃▅▇▅▃",
		window: "7-trading-days",
	};
	const scheduledDate = assertIsoDateString("2026-06-01");
	const scheduledMinutes = assertMinuteOfDay(9 * 60);

	function makeDailyDigestSmsUser(): UserRecord {
		return {
			id: "00000000-0000-0000-0000-000000000001",
			email: "sarah.chen@example.com",
			phone_country_code: "+1",
			phone_number: "5551234567",
			phone_verified: true,
			timezone: "America/New_York",
			use_24_hour_time: false,
			market_scheduled_asset_price_next_send_at: null,
			email_notifications_enabled: false,
			sms_notifications_enabled: true,
			sms_opted_out: false,
			market_scheduled_asset_price_enabled: false,
			market_scheduled_asset_price_times: null,
			daily_digest_time: scheduledMinutes,
			daily_digest_next_send_at: null,
			asset_events_next_send_at: null,
			asset_events_last_analyst_sent_month: null,
			last_grok_rumors_at: null,
			grok_window_start: null,
			grok_sends_in_window: 0,
			telegram_chat_id: null,
			telegram_opted_out: false,
			prefs: makePrefRows([["daily_digest", "prices", "sms", true]]),
		};
	}

	function makeStats(): ScheduledNotificationTotals {
		return {
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			telegramSent: 0,
			telegramFailed: 0,
		};
	}

	function makeLogger(): Logger {
		return {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
	}

	function makeDeliverySupabaseMock() {
		const notificationLogInserts: Record<string, unknown>[] = [];
		const scheduledUpdates: Record<string, unknown>[] = [];

		function makeEqChain(result: Record<string, unknown>) {
			const chain = {
				...result,
				eq: vi.fn(() => chain),
			};
			return chain;
		}

		function makeSelectChain(data: Record<string, unknown> | null) {
			const chain = {
				eq: vi.fn(() => chain),
				maybeSingle: vi.fn(async () => ({ data, error: null })),
			};
			return chain;
		}

		const supabase = {
			// claim_scheduled_notification returns the post-claim attempt_count (>= 1) when claimed.
			rpc: vi.fn(async () => ({ data: 1, error: null })),
			from: vi.fn((table: string) => {
				if (table === "notification_log") {
					return {
						insert: vi.fn(async (insert: Record<string, unknown>) => {
							notificationLogInserts.push(insert);
							return { error: null };
						}),
					};
				}

				if (table === "scheduled_notifications") {
					return {
						select: vi.fn(() => makeSelectChain({ attempt_count: 1, status: "claimed" })),
						update: vi.fn((update: Record<string, unknown>) => {
							scheduledUpdates.push(update);
							return makeEqChain({ error: null });
						}),
					};
				}

				throw new Error(`Unexpected table ${table}`);
			}),
		} as unknown as SupabaseAdminClient;

		return { supabase, notificationLogInserts, scheduledUpdates };
	}

	function buildAssetFixtures(
		count: number,
		prefix = "STK",
	): {
		userAssets: UserAssetRow[];
		assetPrices: AssetPriceMap;
		lines: string[];
	} {
		const userAssets = Array.from({ length: count }, (_, index) => {
			const symbol = `${prefix}${String(index + 1).padStart(3, "0")}`;
			return { symbol, name: `Boundary Asset ${index + 1}` };
		});
		const assetPrices: AssetPriceMap = new Map(
			userAssets.map((asset, index) => [
				asset.symbol,
				{ price: 100 + index + 0.12, changePercent: 1.23 },
			]),
		);
		const lines = userAssets.map(
			(asset, index) => `${asset.symbol} — $${(100 + index + 0.12).toFixed(2)} (+1.23%)`,
		);

		return { userAssets, assetPrices, lines };
	}

	beforeEach(() => {
		vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "test-secret-key");
		vi.stubEnv("VERCEL_URL", "http://localhost:4321");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("sends a single daily digest SMS body without multipart log markers", async () => {
		const { userAssets, assetPrices } = buildAssetFixtures(2, "SS");
		const expectedMessages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
		});
		expect(expectedMessages).toHaveLength(1);
		const expectedBody = finalizeSmsBodyForUcs2Segments(expectedMessages[0] ?? "");
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const stats = makeStats();
		const logger = makeLogger();
		const { supabase, notificationLogInserts, scheduledUpdates } = makeDeliverySupabaseMock();

		await processDailyDigestSmsDelivery({
			user: makeDailyDigestSmsUser(),
			supabase,
			logger,
			scheduledDate,
			scheduledMinutes,
			userAssets,
			assetPrices,
			extras,
			getSmsSender: () => ({ sender: smsSender }),
			stats,
		});

		expect(smsSender).toHaveBeenCalledTimes(1);
		expect(smsSender.mock.calls[0]?.[0].body).toBe(expectedBody);
		expect(stats.smsSent).toBe(1);
		expect(stats.smsFailed).toBe(0);
		expect(notificationLogInserts).toHaveLength(1);
		expect(notificationLogInserts[0]).toMatchObject({
			type: "daily",
			delivery_method: "sms",
			message: expectedMessages[0],
			message_delivered: true,
		});
		expect(notificationLogInserts[0]?.message).not.toContain("--- SMS part");
		expect(scheduledUpdates).toHaveLength(1);
		expect(scheduledUpdates[0]).toMatchObject({
			status: "sent",
			error: null,
			next_retry_at: null,
		});
	});

	it("sends multipart daily digest SMS bodies in order and records one successful attempt", async () => {
		const { userAssets, assetPrices } = buildAssetFixtures(90, "MS");
		const expectedMessages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
		});
		expect(expectedMessages.length).toBeGreaterThan(1);
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const stats = makeStats();
		const logger = makeLogger();
		const { supabase, notificationLogInserts, scheduledUpdates } = makeDeliverySupabaseMock();

		await processDailyDigestSmsDelivery({
			user: makeDailyDigestSmsUser(),
			supabase,
			logger,
			scheduledDate,
			scheduledMinutes,
			userAssets,
			assetPrices,
			extras,
			getSmsSender: () => ({ sender: smsSender }),
			stats,
		});

		expect(smsSender).toHaveBeenCalledTimes(expectedMessages.length);
		expect(smsSender.mock.calls.map(([request]) => request.body)).toEqual(expectedMessages);
		expect(stats.smsSent).toBe(1);
		expect(stats.smsFailed).toBe(0);
		expect(notificationLogInserts).toHaveLength(1);
		expect(notificationLogInserts[0]).toMatchObject({
			type: "daily",
			delivery_method: "sms",
			message_delivered: true,
		});
		expect(notificationLogInserts[0]?.message).toContain(
			`--- SMS part 1/${expectedMessages.length} ---`,
		);
		expect(notificationLogInserts[0]?.message).toContain(
			`--- SMS part ${expectedMessages.length}/${expectedMessages.length} ---`,
		);
		expect(scheduledUpdates).toHaveLength(1);
		expect(scheduledUpdates[0]).toMatchObject({
			status: "sent",
			error: null,
			next_retry_at: null,
		});
	});

	it("stops after a later daily digest SMS part fails and records one failed attempt", async () => {
		const { userAssets, assetPrices } = buildAssetFixtures(90, "MF");
		const expectedMessages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
		});
		expect(expectedMessages.length).toBeGreaterThan(1);
		const smsSender = vi
			.fn<SmsSender>()
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({
				success: false,
				error: "Twilio timeout",
				errorCode: "ETIMEDOUT",
			});
		const stats = makeStats();
		const logger = makeLogger();
		const user = makeDailyDigestSmsUser();
		const { supabase, notificationLogInserts, scheduledUpdates } = makeDeliverySupabaseMock();

		await processDailyDigestSmsDelivery({
			user,
			supabase,
			logger,
			scheduledDate,
			scheduledMinutes,
			userAssets,
			assetPrices,
			extras,
			getSmsSender: () => ({ sender: smsSender }),
			stats,
		});

		expect(smsSender).toHaveBeenCalledTimes(2);
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
		expect(logger.error).toHaveBeenCalledWith(
			"Failed to send Daily Digest SMS part",
			expect.objectContaining({
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				partNumber: 2,
				totalParts: expectedMessages.length,
				partLength: expectedMessages[1]?.length,
				errorCode: "ETIMEDOUT",
			}),
			expect.objectContaining({ message: "Twilio timeout" }),
		);
		expect(notificationLogInserts).toHaveLength(1);
		expect(notificationLogInserts[0]?.message).toContain(
			`--- SMS part 1/${expectedMessages.length} ---`,
		);
		expect(notificationLogInserts[0]?.message).toContain(
			`--- SMS part ${expectedMessages.length}/${expectedMessages.length} ---`,
		);
		expect(notificationLogInserts[0]?.error).toContain(`SMS part 2/${expectedMessages.length}`);
		expect(notificationLogInserts[0]?.error).toContain("Twilio timeout");
		expect(notificationLogInserts[0]).toMatchObject({
			message_delivered: false,
			error_code: "ETIMEDOUT",
		});
		expect(scheduledUpdates).toHaveLength(1);
		expect(scheduledUpdates[0]).toMatchObject({
			status: "failed",
		});
		expect(scheduledUpdates[0]?.error).toContain(`SMS part 2/${expectedMessages.length}`);
		expect(scheduledUpdates[0]?.error).toContain("Twilio timeout");
	});

	it("applies change % preferences in daily digest email", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			extras,
		});

		expect(message.text).not.toContain("💵 Prices");
		expect(message.text).toContain("AAPL — $187.42 (+1.23%)");
		expect(message.text).toContain("MSFT — $412.10 (-0.31%)");
		// Email uses single newline separator
		expect(message.text).toContain("AAPL — $187.42 (+1.23%)\nMSFT — $412.10 (-0.31%)");
		expect(message.html).not.toContain("💵 Prices");
		expect(message.html).toContain("$187.42");
		expect(message.html).toContain("(+1.23%)");
		expect(message.html).toContain("$412.10");
		expect(message.html).toContain("(-0.31%)");
		// Asset list renders as a <table> so columns line up across rows; the
		// sans-serif daily-digest font needs tabular-nums to keep prices aligned.
		expect(message.html).toContain('<table role="presentation"');
		expect(message.html).toContain("font-variant-numeric: tabular-nums");
	});

	it("colors positive change green and negative change red in HTML", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			extras,
		});

		// Green for positive (green-800), red for negative (red-700) — WCAG contrast
		expect(message.html).toContain("color: #166534");
		expect(message.html).toContain("color: #b91c1c");
	});

	it("shows ASCII sparklines in plaintext and SVG in HTML when sparklines provided", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);
		const sparklines = new Map([["AAPL", sparklineData]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			sparklines,
		});

		// Plaintext keeps ASCII sparkline, labeled with the 7-day window
		expect(message.text).toContain("past 7 days: ▁▂▃▅▇▅▃");
		expect(message.text).toContain("+200.00%");
		// HTML gets SVG sparkline <img> plus an inline label
		expect(message.html).toContain("data:image/svg+xml;base64,");
		expect(message.html).toContain("<img ");
		expect(message.html).toContain("Past 7 trading days:");
	});

	it("SMS uses ASCII sparklines, not SVG, and labels the window", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);
		const sparklines = new Map([["AAPL", sparklineData]]);

		const message = formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			sparklines,
		});

		expect(message).toContain("past 7 days: ▁▂▃▅▇▅▃");
		expect(message).not.toContain("data:image/svg+xml;base64,");
	});

	it("always shows change% even with price unavailable", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", null]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			extras,
		});

		expect(message.text).toContain("Your Assets");
		expect(message.text).toContain("AAPL — price unavailable");
		expect(message.text).toContain("MSFT — price unavailable");
	});

	it("SMS includes market closed banner when marketOpen is false", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message).toContain("Market Closed");
		expect(message).toContain("Weekend");
		expect(message).toContain("Prices below reflect the last market close.");
		// Without a sparkline, change % stays hidden on closed-market digests
		expect(message).toContain("AAPL — $187.42");
		expect(message).not.toContain("(+1.23%)");
	});

	it("SMS market-closed banner stamps the 'as of' quote time, matching email", () => {
		// timestamp 1735837200 = 2025-01-02 (EST). Same shared banner as email, so SMS now
		// carries the staleness hint too (was previously email-only).
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message).toMatch(/Prices below reflect the last market close \(as of .+EST\)\./);
	});

	it("closed-market digest shows 7-day change % aligned with the sparkline", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 79.5, changePercent: -1.2 }]]);
		const sparklines = new Map<string, SparklineData>([
			[
				"AAPL",
				{
					values: [75, 76, 77, 78, 79, 79.5],
					ascii: "▁▂▃▄▅▇",
					window: "7-trading-days",
				},
			],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			sparklines,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message.text).toContain("Market Closed");
		expect(message.text).toContain("AAPL — $79.50 (+6.00%)");
		expect(message.text).not.toContain("(-1.20%)");
		expect(message.html).toContain("(+6.00%)");
		expect(message.html).toContain("color: #166534");
	});

	it("SMS omits market closed banner when marketOpen is true", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketOpen: true,
		});

		expect(message).not.toContain("Market Closed");
		// Change percent is shown when market is open
		expect(message).toContain("AAPL — $187.42 (+1.23%)");
	});

	it("formats daily digest SMS with a Your Assets section", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);

		const message = formatDailyDigestSmsMessage({
			userAssets,
			assetPrices,
			extras,
		});

		expect(message).toContain("Your Assets");
		expect(message).not.toContain("Tickers:");
		expect(message).not.toContain("💵 Prices");
		expect(message).toContain("AAPL — $187.42 (+1.23%)");
		expect(message).toContain("MSFT — $412.10 (-0.31%)");
	});

	it("keeps analyst consensus counts with their section heading across SMS bodies", () => {
		const { userAssets, assetPrices } = buildAssetFixtures(65, "AC");

		const messages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
			assetEvents: {
				eventsSection: {
					earnings: "RTX: earnings expected tomorrow before market open",
					dividends: "AAPL: ex-dividend date lands this week",
					splits: null,
					ipos: null,
				},
				analystSection: "LDOS: 8 Buy, 11 Hold, 0 Sell",
				insiderSection: null,
				hasAnyContent: true,
			},
		});

		expect(messages.length).toBeGreaterThan(1);
		const analystMessage = messages.find((message) => message.includes("📊 Analyst Consensus"));
		expect(analystMessage).toContain("📊 Analyst Consensus\nLDOS: 8 Buy, 11 Hold, 0 Sell");
		for (const message of messages.filter((message) => !message.includes("📊 Analyst Consensus"))) {
			expect(message).not.toContain("LDOS: 8 Buy, 11 Hold, 0 Sell");
		}
	});

	it("keeps the SMS footer opt-out text with the dashboard link in the final body", () => {
		const { userAssets, assetPrices } = buildAssetFixtures(85, "FT");

		const messages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
		});

		expect(messages.length).toBeGreaterThan(1);
		const finalBody = messages.at(-1);
		expect(finalBody).toContain("Manage your notifications:");
		expect(finalBody).toContain("Reply STOP to opt out.");
		expect(finalBody?.indexOf("Manage your notifications:")).toBeLessThan(
			finalBody?.indexOf("Reply STOP to opt out.") ?? -1,
		);
		for (const message of messages.slice(0, -1)) {
			expect(message).not.toContain("Reply STOP to opt out.");
		}
	});

	it("pads the dashboard URL after each final SMS body is packed", () => {
		vi.stubEnv("SITE_URL", "http://localhost:4321");
		const { userAssets, assetPrices } = buildAssetFixtures(53, "URL");
		const footerLabel = "Manage your notifications:\n";
		const insiderBlockPrefix = "🏦 Insider Trades\n";
		const minimumInsiderFiller = 1250;
		const targetUrlRemainder = 60;
		const baseUrlIndex = insiderBlockPrefix.length + minimumInsiderFiller + 2 + footerLabel.length;
		const insiderFillerLength =
			minimumInsiderFiller + ((targetUrlRemainder - (baseUrlIndex % 67) + 67) % 67);

		const messages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
			assetEvents: {
				eventsSection: { earnings: null, dividends: null, splits: null, ipos: null },
				analystSection: null,
				insiderSection: "I".repeat(insiderFillerLength),
				hasAnyContent: true,
			},
		});

		expect(messages.length).toBeGreaterThan(1);
		const finalBody = messages.at(-1) ?? "";
		const dashboardUrlMatch = finalBody.match(/https?:\/\/\S+\/dashboard/);
		expect(dashboardUrlMatch?.index).toBeGreaterThan(-1);
		const urlSpan = findDailyDigestProtectedSpans(finalBody).find((span) => {
			const text = finalBody.slice(span.start, span.end);
			return text.includes("/dashboard");
		});
		expect(urlSpan).toBeDefined();
		expect(spanStraddlesBoundary(urlSpan?.start ?? -1, urlSpan?.end ?? -1)).toBe(false);
	});

	it("puts the dashboard URL on its own line so iOS cannot split inside notifications", () => {
		const userAssets: UserAssetRow[] = [{ symbol: "A01", name: "Sample A01" }];
		const assetPrices: AssetPriceMap = new Map([["A01", { price: 100.12, changePercent: -3.65 }]]);
		const analystSection = ["LDOS", "BAH", "CACI", "PLTR", "ACN", "RTX"]
			.map((symbol) => `${symbol}: 8 Buy, 11 Hold, 0 Sell`)
			.join("\n");

		const [body] = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
			marketOpen: true,
			assetEvents: {
				eventsSection: { earnings: null, dividends: null, splits: null, ipos: null },
				analystSection,
				insiderSection: null,
				hasAnyContent: true,
			},
		});
		const wrapped = finalizeSmsBodyForUcs2Segments(
			`[STA padding sample]\n5/10 analyst — consensus block\n\n${body}`,
		);

		expect(wrapped).not.toContain("Manage your notifications: http://");
		expect(wrapped).toMatch(/Manage your notifications:\nhttp:\/\/localhost\/dashboard/);
		const footerStart = wrapped.indexOf("Manage your notifications:");
		const footerEnd =
			wrapped.indexOf("http://localhost/dashboard") + "http://localhost/dashboard".length;
		expect(spanStraddlesBoundary(footerStart, footerEnd)).toBe(false);
	});

	it("keeps reported closed-market SMS digest spacing compact after segment padding", () => {
		const userAssets: UserAssetRow[] = [
			{ symbol: "LMT", name: "Lockheed Martin" },
			{ symbol: "NOC", name: "Northrop Grumman" },
		];
		const assetPrices: AssetPriceMap = new Map([
			["LMT", { price: 511, changePercent: -3.65 }],
			["NOC", { price: 536.5, changePercent: -3.63 }],
		]);
		const sparklines = new Map<string, SparklineData>([
			[
				"LMT",
				{
					values: [100, 99, 102, 98, 96.35],
					ascii: "▆▆█▆▁▁",
					window: "7-trading-days",
				},
			],
			[
				"NOC",
				{
					values: [100, 98, 101, 103, 96.37],
					ascii: "▆▄▆█▁▁",
					window: "7-trading-days",
				},
			],
		]);
		const ipos = [
			"LFTO: IPO tomorrow",
			"WHK: IPO in 2 days (06-05)",
			"SSMR: IPO tomorrow",
			"QNT: IPO tomorrow",
			"SFPT: IPO tomorrow",
			"INIO: IPO tomorrow",
			"AESPU: IPO today",
			"AADX: IPO today",
		].join("\n");

		const messages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
			sparklines,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
			assetEvents: {
				eventsSection: { earnings: null, dividends: null, splits: null, ipos },
				analystSection: null,
				insiderSection: null,
				hasAnyContent: true,
			},
		});
		const joined = messages.join("\n\n");

		expect(joined).toContain("LMT — $511.00 (-3.65%) past 7 days: ▆▆█▆▁▁");
		expect(joined).toContain("NOC — $536.50 (-3.63%) past 7 days: ▆▄▆█▁▁");
		expect(joined).toContain("🆕 Upcoming IPOs\nLFTO: IPO tomorrow");
		expect(joined).toMatch(
			/AADX: IPO today *\n\nManage your notifications:\nhttp:\/\/localhost\/dashboard/,
		);
		expect(joined).toContain("Manage your notifications:\nhttp://localhost/dashboard");
		for (const message of messages) {
			expect(message).not.toMatch(/\n{3,}/);
		}
	});

	it("keeps upcoming IPO rows off UCS-2 segment boundaries in typical closed-market digests", () => {
		const symbols = ["LDOS", "BAH", "CACI", "SAIC", "ACN", "PLTR", "RTX", "GD", "LMT", "NOC"];
		const userAssets: UserAssetRow[] = symbols.map((symbol) => ({
			symbol,
			name: `${symbol} Inc`,
		}));
		const assetPrices: AssetPriceMap = new Map(
			symbols.map((symbol, index) => [
				symbol,
				{ price: 100 + index, changePercent: index % 2 === 0 ? -0.31 : 5.18 },
			]),
		);
		const sparklines = new Map(symbols.map((symbol) => [symbol, sparklineData]));
		const ipos = [
			"SFPT: IPO in 2 days (06-04)",
			"SSMR: IPO in 2 days (06-04)",
			"QNT: IPO in 2 days (06-04)",
			"INIO: IPO in 2 days (06-04)",
			"AESPU: IPO tomorrow",
			"AADX: IPO tomorrow",
		].join("\n");

		const messages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
			sparklines,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
			assetEvents: {
				eventsSection: { earnings: null, dividends: null, splits: null, ipos },
				analystSection: null,
				insiderSection: null,
				hasAnyContent: true,
			},
		});

		const joined = messages.join("\n\n");
		const inioLine = "INIO: IPO in 2 days (06-04)";
		expect(joined).toContain(inioLine);

		const inioIndex = joined.indexOf(inioLine);
		expect(spanStraddlesBoundary(inioIndex, inioIndex + inioLine.length)).toBe(false);

		for (const message of messages) {
			for (const span of findDailyDigestProtectedSpans(message)) {
				const spanLength = span.end - span.start;
				if (spanLength <= SMS_UCS2_SEGMENT_SIZE) {
					expect(spanStraddlesBoundary(span.start, span.end)).toBe(false);
				}
			}
		}
	});

	it("splits long asset lists only between complete asset entries", () => {
		const { userAssets, assetPrices, lines } = buildAssetFixtures(90, "AS");

		const messages = formatDailyDigestSmsMessages({
			userAssets,
			assetPrices,
			extras,
		});
		const joined = messages.join("\n\n");

		expect(messages.length).toBeGreaterThan(1);
		expect(joined).toContain(lines[0]);
		expect(joined).toContain(lines.at(-1));
		for (const line of lines) {
			expect(messages.filter((message) => message.includes(line))).toHaveLength(1);
		}
		for (const message of messages.filter((message) =>
			lines.some((line) => message.includes(line)),
		)) {
			expect(message).toMatch(/(?:^|\n\n)💰 Your Assets\n/);
		}
	});

	it("formats rumor ticker sections with blank lines between tickers", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				rumors: "AAPL: First rumor line\nMSFT: Second rumor line",
			},
		});

		expect(message.text).toContain("🤫 Rumors\nAAPL: First rumor line\n\nMSFT: Second rumor line");
		expect(message.html).toContain("<strong>AAPL:</strong> First rumor line");
		expect(message.html).toContain("<strong>MSFT:</strong> Second rumor line");
	});

	it("preserves single blank-line spacing when rumors already contain it", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				rumors: "AAPL: First rumor line\n\nMSFT: Second rumor line",
			},
		});

		expect(message.text).toContain("🤫 Rumors\nAAPL: First rumor line\n\nMSFT: Second rumor line");
		expect(message.text).not.toContain(
			"🤫 Rumors\nAAPL: First rumor line\n\n\nMSFT: Second rumor line",
		);
	});

	it("formats news ticker sections with blank lines between tickers", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				news: "AAPL: First news line\nMSFT: Second news line",
			},
		});

		expect(message.text).toContain("🗞️ News\nAAPL: First news line\n\nMSFT: Second news line");
		expect(message.html).toContain("<strong>AAPL:</strong> First news line");
		expect(message.html).toContain("<strong>MSFT:</strong> Second news line");
	});

	it("omits price disclaimer when market is open (no closure info)", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
		});

		expect(message.text).not.toContain("Prices reflect");
		expect(message.text).not.toContain("Market Closed");
		expect(message.html).not.toContain("Market Closed");
	});

	it("shows market-closed banner for weekend closure", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message.text).toContain("Market Closed — Weekend");
		expect(message.text).toContain("Prices below reflect the last market close");
		expect(message.text).toMatch(/as of .+EST/);
		expect(message.html).toContain("Market Closed — Weekend");
		expect(message.html).toContain("Prices below reflect the last market close");
		// Banner uses amber styling
		expect(message.html).toContain("#fef3c7");
		// Change percent is omitted outside market hours
		expect(message.text).toContain("AAPL — $187.42");
		expect(message.text).not.toContain("(+1.23%)");
		expect(message.html).toContain("$187.42");
		expect(message.html).not.toContain("(+1.23%)");
	});

	it("shows market-closed banner with holiday name", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketOpen: false,
			marketClosureInfo: { reason: "holiday", holidayName: "Presidents' Day" },
		});

		expect(message.text).toContain("Market Closed — Presidents' Day");
		expect(message.html).toContain("Market Closed — Presidents&#39; Day");
		// Change percent omitted outside market hours
		expect(message.text).not.toContain("(+1.23%)");
	});

	it("shows market-closed banner without timestamp when no quotes have timestamps", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketOpen: false,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message.text).toContain("Market Closed — Weekend");
		expect(message.text).toContain("Prices below reflect the last market close.");
		expect(message.text).not.toContain("as of");
		// Change percent omitted outside market hours
		expect(message.text).not.toContain("(+1.23%)");
	});

	it("renders top movers section in email when opted in", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				topMovers:
					"Gainers:\nSKYQ — $12.59 (+74.49%)\nNVDA — $495.30 (+4.12%)\n\nLosers:\nBIIB — $212.45 (-18.67%)",
			},
		});

		expect(message.text).toContain("🚀 Top Movers");
		expect(message.text).toContain("Gainers:");
		expect(message.text).toContain("SKYQ — $12.59 (+74.49%)");
		expect(message.text).toContain("Losers:");
		expect(message.text).toContain("BIIB — $212.45 (-18.67%)");
		expect(message.html).toContain("Top Movers");
		expect(message.html).toContain("SKYQ");
		expect(message.html).toContain("BIIB");
	});

	it("omits top movers section from email when not opted in", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
		});

		expect(message.text).not.toContain("Top Movers");
		expect(message.html).not.toContain("Top Movers");
	});

	it("renders top movers section in SMS when extras.topMovers is set", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				topMovers: "Gainers:\nSKYQ — $12.59 (+74.49%)",
			},
		});

		expect(message).toContain("🚀 Top Movers");
		expect(message).toContain("Gainers:");
		expect(message).toContain("SKYQ — $12.59 (+74.49%)");
	});

	it("omits top movers section from SMS when extras.topMovers is absent", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
		});

		expect(message).not.toContain("Top Movers");
		expect(message).not.toContain("SKYQ");
	});

	it("includes Finnhub logo on Earnings and Massive logos on calendar sections in digest HTML", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			assetEvents: {
				eventsSection: {
					earnings: "RTX: earnings in 2 days",
					dividends: "AAPL: ex-div tomorrow",
					splits: "TSLA: split next week",
					ipos: "FOO: IPO Friday",
				},
				insiderSection: null,
				analystSection: null,
				hasAnyContent: true,
			},
		});

		const finnhubAlts = message.html.match(/alt="Powered by Finnhub"/g) ?? [];
		const massiveAlts = message.html.match(/alt="Powered by Massive"/g) ?? [];

		// Earnings → Finnhub; dividends, splits, IPOs → Massive (no news/top movers in extras)
		expect(finnhubAlts.length).toBe(1);
		expect(massiveAlts.length).toBe(3);
	});
});
