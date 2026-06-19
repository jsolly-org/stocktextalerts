import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import {
	deliverPriceAlert,
	type PriceAlertDeliveryStats,
} from "../../../src/lib/market-notifications/delivery";
import type { EnrichedAlert } from "../../../src/lib/market-notifications/enrichment";
import type { PriceAlertGrokResult } from "../../../src/lib/market-notifications/grok-summary";
import type { PriceAlertUser } from "../../../src/lib/market-notifications/users";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramMessage, TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import type { DeliveryResult } from "../../../src/lib/messaging/types";

function makeSupabaseMock(): AppSupabaseClient {
	const noopChain = {
		select: () => ({
			eq: () => ({
				gt: () => ({
					limit: () => ({
						single: () => Promise.resolve({ data: null, error: null }),
					}),
				}),
			}),
		}),
		insert: async () => ({ error: null }),
	};
	return {
		from: () => noopChain,
	} as unknown as AppSupabaseClient;
}

function makeStats(): PriceAlertDeliveryStats {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};
}

function makeGrokResult(overrides: Partial<PriceAlertGrokResult> = {}): PriceAlertGrokResult {
	return {
		summary:
			"LDOS shares fell after the company reported weaker-than-expected guidance amid reduced federal spending.[[Reuters]](https://www.reuters.com/example)[[@analyst123]](https://x.com/analyst123/status/123456)",
		links: [
			{
				url: "https://www.reuters.com/example",
				title: "Leidos cuts guidance",
				source: "Reuters",
				sourceType: "web",
			},
			{
				url: "https://x.com/analyst123/status/123456",
				title: "LDOS selloff analysis",
				source: "@analyst123",
				sourceType: "x",
			},
		],
		...overrides,
	};
}

function makeAlert(overrides: Partial<EnrichedAlert> = {}): EnrichedAlert {
	return {
		symbol: "LDOS",
		priceContext: "LDOS is down 11.1% today ($173.00)",
		signalContext: "The broader market (SPY) moved 0.85% today.",
		grokContext:
			"down 11.10% ($21.42) from previous close, anomaly score 52/75 (sustained, vol 1.2x)",
		grokResult: null,
		intradayCloses: null,
		intradayTimestamps: null,
		intradayEndTimestamp: null,
		intradayCandles: null,
		prevClose: 194.42,
		isPositiveMove: false,
		...overrides,
	};
}

function makeUser(overrides: Partial<PriceAlertUser> = {}): PriceAlertUser {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		email: "test@example.com",
		phone_country_code: "+1",
		phone_number: "5551112222",
		phone_verified: true,
		sms_notifications_enabled: true,
		sms_opted_out: false,
		market_asset_price_alerts_include_email: false,
		market_asset_price_alerts_include_sms: true,
		market_asset_price_alert_move_size: "extreme",
		use_24_hour_time: false,
		telegram_chat_id: null,
		telegram_opted_out: false,
		...overrides,
	};
}

describe("deliverPriceAlert SMS eligibility", () => {
	it("does not attempt SMS when user is opted out", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ sms_opted_out: true }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});

	it("does not attempt SMS when phone number is missing", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ phone_number: null }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});

	it("does not attempt SMS when phone is not verified", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ phone_verified: false }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});

	it("does not attempt SMS when sms_notifications_enabled is false", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ sms_notifications_enabled: false }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});
});

describe("A user with price alerts enabled receives Grok-enriched move context", () => {
	it("includes a concise why-moving summary and source links in SMS", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({ grokResult: makeGrokResult() }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0]![0].body;
		expect(smsBody).toContain("weaker-than-expected guidance");
		// URLs should be present (shortened or original)
		expect(smsBody).toMatch(/https?:\/\//);
	});

	it("includes summary but no links in SMS when Grok returns no links", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({
				grokResult: makeGrokResult({
					summary:
						"LDOS shares fell after the company reported weaker-than-expected guidance amid reduced federal spending.",
					links: [],
				}),
			}),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0]![0].body;
		expect(smsBody).toContain("weaker-than-expected guidance");
		expect(smsBody).not.toContain("reuters.com");
	});

	it("omits why-moving section in SMS when Grok result is unavailable", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({ grokResult: null }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0]![0].body;
		expect(smsBody).not.toContain("guidance");
		expect(smsBody).toContain("LDOS is down");
		expect(smsBody).toContain("broader market");
	});

	it("email HTML includes a why-moving section with source labels", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ grokResult: makeGrokResult() }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: vi.fn<SmsSender>(async () => ({ success: true })),
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const emailCall = sendEmail.mock.calls[0]![0] as {
			html: string;
			body: string;
		};
		expect(emailCall.html).toContain("Why it's moving");
		expect(emailCall.html).toContain("Reuters");
		expect(emailCall.html).toContain("@analyst123");
		expect(emailCall.html).toContain("weaker-than-expected guidance");
		// Links are rendered inline as <a> tags (not a separate list)
		expect(emailCall.html).toContain('href="https://www.reuters.com/example"');
		expect(emailCall.html).toContain('href="https://x.com/analyst123/status/123456"');
	});

	it("email plaintext includes the why-moving section", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ grokResult: makeGrokResult() }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: vi.fn<SmsSender>(async () => ({ success: true })),
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const emailCall = sendEmail.mock.calls[0]![0] as { body: string };
		expect(emailCall.body).toContain("Why it's moving");
		expect(emailCall.body).toContain("via Reuters");
		expect(emailCall.body).toContain("via @analyst123 on X");
	});

	it("email omits why-moving section when Grok result is unavailable", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ grokResult: null }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: vi.fn<SmsSender>(async () => ({ success: true })),
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const emailCall = sendEmail.mock.calls[0]![0] as { html: string };
		expect(emailCall.html).not.toContain("Why it");
	});
});

describe("deliverPriceAlert intraday sparklines", () => {
	// Bars frame an LDOS-style selloff: opened down ~10% from prev close
	// ($194.42) and continued lower through the session. Plausible alongside
	// the priceContext fixture ("LDOS is down 11.1% today ($173.00)").
	const intradayCloses = [175.6, 174.8, 174.1, 173.7, 173.2, 172.9, 173.0];

	it("SMS body contains Unicode sparkline when intradayCloses has data", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({ intradayCloses }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0]![0].body;
		// Sparkline anchors at prev close (Robinhood "1D") so its first-to-last
		// delta matches the prev-close-anchored headline %; SMS label is "today".
		expect(smsBody).toContain("today:");
		// Unicode block characters are in the range U+2581–U+2588
		expect(smsBody).toMatch(/[▁▂▃▄▅▆▇█]/);
	});

	it("SMS body has no sparkline when intradayCloses is null", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({ intradayCloses: null }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0]![0].body;
		expect(smsBody).not.toContain("today:");
		expect(smsBody).not.toContain("since open:");
	});

	it("email HTML contains sparkline img when intradayCloses has data", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ intradayCloses }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		// sendEmail receives { to, subject, body, html }
		const emailCall = sendEmail.mock.calls[0]![0] as { html: string };
		expect(emailCall.html).toContain("<img");
		// Email label is "Today" (Robinhood-style "1D") since chart is anchored
		// to prev close.
		expect(emailCall.html).toContain("Today:");
	});

	it("email HTML has no sparkline when intradayCloses is null", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ intradayCloses: null }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const emailCall = sendEmail.mock.calls[0]![0] as { html: string };
		expect(emailCall.html).not.toContain("Today:");
		expect(emailCall.html).not.toContain("Today since open:");
	});

	it("email HTML falls back to the intraday-since-open chart with time axis when prev close is unavailable (delisted/fresh listing)", async () => {
		// Without a prev close to prepend, the renderer keeps the today's-open
		// time axis so the reader still sees hourly ticks. Use real bar
		// timestamps: 9:30 ET → 10:40 ET so the hourly "10:00" tick appears.
		const intradayWithHourlyTick = [
			100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114,
		];
		// 2025-02-25 10:40 ET (EST = UTC-5)
		const endTs = Date.UTC(2025, 1, 25, 15, 40, 0);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
				use_24_hour_time: true,
			}),
			alert: makeAlert({
				intradayCloses: intradayWithHourlyTick,
				intradayEndTimestamp: endTs,
				prevClose: null,
			}),
			supabase: makeSupabaseMock(),
			sendEmail: sendEmail,
			sendSms: vi.fn<SmsSender>(async () => ({ success: true })),
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const emailCall = sendEmail.mock.calls[0]![0] as { html: string };
		expect(emailCall.html).toContain("Today since open:");
		// Labels are inside the base64-encoded SVG image payload.
		const svgBase64 = emailCall.html.match(/data:image\/svg\+xml;base64,([^"]+)/)?.[1] ?? "";
		const svg = Buffer.from(svgBase64, "base64").toString("utf-8");
		// 24h format shows "10:00" for 10:00; 12h would show "10a"
		expect(svg).toContain("10:00");
	});
});

type TelegramPrefRowFixture = { notification_type: string; content: string; enabled: boolean };
type RecordedInsert = { table: string; row: Record<string, unknown> };

/**
 * Supabase mock for the Telegram delivery path: serves `notification_preferences`
 * rows from a fixture and records every `notification_log` insert so the test can
 * assert the persisted delivery_method. The Grok-URL-shortener chain (used by the
 * SMS path only) is also stubbed so a mixed email/SMS+Telegram user doesn't crash.
 */
function makeTelegramSupabaseMock(prefRows: TelegramPrefRowFixture[]): {
	client: AppSupabaseClient;
	inserts: RecordedInsert[];
} {
	const inserts: RecordedInsert[] = [];
	const client = {
		from(table: string) {
			if (table === "notification_preferences") {
				// .select(...).eq(...).eq(...).eq(...) is awaited at the last .eq(); model it as a
				// resolved Promise carrying an `eq` method so any number of chained .eq() calls
				// return the same awaitable (a real Promise, so no hand-rolled `then`).
				const result = { data: prefRows, error: null };
				const eqChain: Promise<typeof result> & { eq: () => typeof eqChain } = Object.assign(
					Promise.resolve(result),
					{ eq: () => eqChain },
				);
				return { select: () => eqChain };
			}
			if (table === "notification_log") {
				return {
					insert: async (row: Record<string, unknown>) => {
						inserts.push({ table, row });
						return { error: null };
					},
				};
			}
			// short_urls dedup lookup used by the SMS formatter.
			return {
				select: () => ({
					eq: () => ({
						gt: () => ({ limit: () => ({ single: async () => ({ data: null, error: null }) }) }),
					}),
				}),
				insert: async (row: Record<string, unknown>) => {
					inserts.push({ table, row });
					return { error: null };
				},
			};
		},
	} as unknown as AppSupabaseClient;
	return { client, inserts };
}

describe("A Telegram-linked user receives an anomaly price alert via Telegram", () => {
	it("sends a Telegram message and logs delivery_method='telegram' when the market_asset_price_alerts Telegram pref is enabled", async () => {
		const { client, inserts } = makeTelegramSupabaseMock([
			{ notification_type: "market_asset_price_alerts", content: "", enabled: true },
		]);
		const sendTelegram = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "tg-123",
		}));
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		const delivered = await deliverPriceAlert({
			// Telegram-only user: email/SMS off, Telegram chat linked.
			user: makeUser({
				market_asset_price_alerts_include_email: false,
				market_asset_price_alerts_include_sms: false,
				telegram_chat_id: 987654321,
			}),
			alert: makeAlert(),
			supabase: client,
			sendEmail,
			sendSms: null,
			sendTelegram,
			stats,
		});

		expect(delivered).toBe(true);
		expect(sendTelegram).toHaveBeenCalledOnce();
		const sent = sendTelegram.mock.calls[0]![0] as TelegramMessage;
		expect(sent.chatId).toBe(987654321);
		expect(sent.text).toContain("LDOS");
		expect(stats.telegramSent).toBe(1);
		expect(sendEmail).not.toHaveBeenCalled();

		const tgLog = inserts.find(
			(i) => i.table === "notification_log" && i.row.delivery_method === "telegram",
		);
		expect(tgLog).toBeDefined();
		expect(tgLog?.row.type).toBe("price_alert");
		expect(tgLog?.row.message_delivered).toBe(true);
	});

	it("skips Telegram when the user has no market_asset_price_alerts Telegram pref enabled", async () => {
		const { client, inserts } = makeTelegramSupabaseMock([
			{ notification_type: "market_asset_price_alerts", content: "", enabled: false },
		]);
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: false,
				market_asset_price_alerts_include_sms: false,
				telegram_chat_id: 987654321,
			}),
			alert: makeAlert(),
			supabase: client,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			sendSms: null,
			sendTelegram,
			stats,
		});

		expect(sendTelegram).not.toHaveBeenCalled();
		expect(stats.telegramSent).toBe(0);
		expect(
			inserts.some((i) => i.table === "notification_log" && i.row.delivery_method === "telegram"),
		).toBe(false);
	});

	it("does not query Telegram prefs or send when the channel is unusable (no linked chat)", async () => {
		const { client } = makeTelegramSupabaseMock([
			{ notification_type: "market_asset_price_alerts", content: "", enabled: true },
		]);
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: false,
				market_asset_price_alerts_include_sms: false,
				telegram_chat_id: null,
			}),
			alert: makeAlert(),
			supabase: client,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			sendSms: null,
			sendTelegram,
			stats,
		});

		expect(sendTelegram).not.toHaveBeenCalled();
	});
});
