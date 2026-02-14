import type { buildAssetEventsContent } from "../asset-events/content";
import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { escapeHtml } from "../messaging/asset-formatting";
import { renderEmailSection } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import type { SmsExtras } from "../messaging/sms/delivery";
import { formatExtrasSection } from "../messaging/sms/formatting";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { SparklineMap } from "../messaging/sparkline";
import type {
	FormatPreferences,
	UserAssetRow,
	UserRecord,
} from "../messaging/types";
import type { AssetPriceMap } from "../providers/price-fetcher";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../schedule/helpers";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";

export type AssetEventsResult = Awaited<
	ReturnType<typeof buildAssetEventsContent>
> | null;

/**
 * Format the daily digest message body for SMS delivery.
 *
 * Keeps the message readable in plain text and appends a required STOP opt-out suffix.
 */
export function formatDailyDigestSmsMessage(options: {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	formatPrefs: FormatPreferences;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
}): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const tickers = options.userAssets.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "";
	const prices = buildDailyDigestPricesSummary(
		options.userAssets,
		options.assetPrices,
		options.formatPrefs,
		options.sparklines,
	);

	const ae = options.assetEvents;
	const sections = [
		"StockTextAlerts — Daily digest",
		tickersLine,
		prices ? `💵 Prices\n${prices}` : "",
		formatExtrasSection("🗞️ News", options.extras.news),
		formatExtrasSection("🤫 Rumors", options.extras.rumors),
		formatExtrasSection("📈 Earnings", ae?.eventsSection?.earnings),
		formatExtrasSection("💰 Dividends", ae?.eventsSection?.dividends),
		formatExtrasSection("✂️ Splits", ae?.eventsSection?.splits),
		formatExtrasSection("🆕 Upcoming IPOs", ae?.eventsSection?.ipos),
		formatExtrasSection("📊 Analyst Consensus", ae?.analystSection),
		formatExtrasSection("🏦 Insider Trades", ae?.insiderSection),
		`Manage your settings: ${dashboardUrl}`,
		optOutSuffix,
	].filter((value) => Boolean(value));

	return sections.join("\n\n");
}

function formatDailyDigestPriceLine(
	asset: UserAssetRow,
	quote: { price: number; changePercent: number } | null | undefined,
	formatPrefs: FormatPreferences,
	sparkline?: string | null,
): string {
	const base = formatPrefs.show_company_name
		? `${asset.symbol} - ${asset.name}`
		: asset.symbol;
	if (!quote) {
		return `${base} — price unavailable`;
	}
	const sign = quote.changePercent >= 0 ? "+" : "";
	const priceStr = `$${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
	const effectiveSparkline =
		formatPrefs.show_sparklines && sparkline ? ` ${sparkline}` : "";
	return `${base} — ${priceStr}${effectiveSparkline}`;
}

function buildDailyDigestPricesSummary(
	userAssets: UserAssetRow[],
	assetPrices: AssetPriceMap,
	formatPrefs: FormatPreferences,
	sparklines?: SparklineMap,
): string {
	if (userAssets.length === 0) {
		return "";
	}
	const separator = formatPrefs.detailed_format ? "\n\n" : "\n";
	return userAssets
		.map((asset) =>
			formatDailyDigestPriceLine(
				asset,
				assetPrices.get(asset.symbol),
				formatPrefs,
				sparklines?.get(asset.symbol),
			),
		)
		.join(separator);
}

/**
 * Format the daily digest payload for email delivery.
 *
 * Produces a plain-text version for logging and a simple HTML version for rendering.
 */
export function formatDailyDigestEmail(options: {
	user: { id: string; email: string };
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	formatPrefs: FormatPreferences;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
}): { subject: string; text: string; html: string } {
	const tickers = options.userAssets.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "(none)";
	const urls = buildEmailUrls(
		options.user.id,
		options.user.email,
		"dailyNotifications",
	);

	const news = (options.extras.news ?? "").trim();
	const rumors = (options.extras.rumors ?? "").trim();

	const ae = options.assetEvents;
	const earnings = (ae?.eventsSection?.earnings ?? "").trim();
	const dividends = (ae?.eventsSection?.dividends ?? "").trim();
	const splits = (ae?.eventsSection?.splits ?? "").trim();
	const ipos = (ae?.eventsSection?.ipos ?? "").trim();
	const analyst = (ae?.analystSection ?? "").trim();
	const insider = (ae?.insiderSection ?? "").trim();
	const prices = buildDailyDigestPricesSummary(
		options.userAssets,
		options.assetPrices,
		options.formatPrefs,
		options.sparklines,
	);
	const digestTickerBody = prices || tickersLine;

	const sectionsText = [
		"Daily digest",
		digestTickerBody,
		news ? `\n🗞️ News\n${news}` : "",
		rumors ? `\n🤫 Rumors\n${rumors}` : "",
		earnings ? `\n📈 Earnings\n${earnings}` : "",
		dividends ? `\n💰 Dividends\n${dividends}` : "",
		splits ? `\n✂️ Splits\n${splits}` : "",
		ipos ? `\n🆕 Upcoming IPOs\n${ipos}` : "",
		analyst ? `\n📊 Analyst Consensus\n${analyst}` : "",
		insider ? `\n🏦 Insider Trades\n${insider}` : "",
		`\nManage your settings: ${urls.dashboardUrl}`,
		`Manage your delivery schedule: ${urls.scheduleUrl}`,
		`Unsubscribe: ${urls.unsubscribeUrl}`,
	].filter(Boolean);

	const subject = "Daily digest";
	const text = sectionsText.join("\n");

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-radius: 10px;">
		<h2 style="margin: 0 0 8px; font-size: 18px;">Daily digest</h2>
		<pre style="white-space: pre-wrap; margin: 0 0 16px; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${escapeHtml(digestTickerBody)}</pre>
		${renderEmailSection("🗞️", "News", news, { showGrokLogo: true, showFinnhubLogo: true })}
		${renderEmailSection("🤫", "Rumors", rumors, { showGrokLogo: true })}
		${renderEmailSection("📈", "Earnings", earnings)}
		${renderEmailSection("💰", "Dividends", dividends)}
		${renderEmailSection("✂️", "Splits", splits)}
		${renderEmailSection("🆕", "Upcoming IPOs", ipos)}
		${renderEmailSection("📊", "Analyst Consensus", analyst, { showFinnhubLogo: true })}
		${renderEmailSection("🏦", "Insider Trades", insider, { showFinnhubLogo: true })}
		<div style="text-align: center; margin-top: 20px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your settings →
			</a>
		</div>
		${renderEmailFooter(urls)}
	</div>
</body>
</html>`;

	return { subject, text, html };
}

/**
 * Deliver a daily digest via email and record the result.
 *
 * Uses the `claim_scheduled_notification` RPC to ensure idempotent delivery across retries
 * and parallel runners, then writes a `scheduled_notifications` status update.
 */
export async function processDailyDigestEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	formatPrefs: FormatPreferences;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		assetPrices,
		formatPrefs,
		extras,
		assetEvents,
		sendEmail,
		stats,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.emailsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted") {
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `daily-digest/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const message = formatDailyDigestEmail({
		user,
		userAssets,
		assetPrices,
		formatPrefs,
		extras,
		assetEvents,
		sparklines: options.sparklines,
	});
	const result = await sendUserEmail(
		user,
		message.subject,
		{ text: message.text, html: message.html },
		sendEmail,
		emailIdempotencyKey,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "email",
		message_delivered: result.success,
		message: message.text,
		error: result.success ? undefined : result.error,
		error_code: result.success ? undefined : result.errorCode,
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (result.success) {
		stats.emailsSent++;
	} else {
		stats.emailsFailed++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}

/**
 * Deliver a daily digest via SMS and record the result.
 *
 * Uses the `claim_scheduled_notification` RPC for idempotency. If the user is opted out or
 * lacks SMS capability, the function returns without delivery.
 */
export async function processDailyDigestSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		getSmsSender,
		stats,
	} = options;

	if (!shouldSendSms(user)) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.smsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted") {
		stats.skipped++;
		return;
	}

	let smsSenderResult: ReturnType<SmsSenderProvider>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender for daily digest",
			{ userId: user.id, scheduledDate, scheduledMinutes, errorMessage },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});
		return;
	}

	const smsMessage = formatDailyDigestSmsMessage({
		userAssets,
		assetPrices,
		formatPrefs: {
			show_sparklines: user.show_sparklines,
			show_company_name: user.show_company_name,
			detailed_format: user.detailed_format,
		},
		extras,
		assetEvents,
	});
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "sms",
		message_delivered: result.success,
		message: smsMessage,
		error: result.success ? undefined : result.error,
		error_code: result.success ? undefined : result.errorCode,
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (result.success) {
		stats.smsSent++;
	} else {
		stats.smsFailed++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
