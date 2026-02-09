import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import {
	buildEmailUrls,
	renderEmailFooter,
} from "../messaging/email/email-layout";
import { renderEmailSection } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import type { SmsExtras } from "../messaging/sms/delivery";
import { formatExtrasSection } from "../messaging/sms/formatting";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { escapeHtml } from "../messaging/stock-formatting";
import type { UserRecord, UserStockRow } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { claimNotification, updateScheduledNotificationRow } from "./helpers";
import type { SmsSenderProvider } from "./run-user-sms-sender";

/**
 * Format the daily digest message body for SMS delivery.
 *
 * Keeps the message readable in plain text and appends a required STOP opt-out suffix.
 */
function formatDailyDigestSmsMessage(options: {
	userStocks: UserStockRow[];
	extras: SmsExtras;
}): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const tickers = options.userStocks.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "";

	const sections = [
		"StockTextAlerts — Daily digest",
		tickersLine,
		formatExtrasSection("🗞️ News", options.extras.news),
		formatExtrasSection("🤫 Rumors", options.extras.rumors),
		formatExtrasSection("📊 Analyst Consensus", options.extras.analyst),
		formatExtrasSection("🏦 Insider Trades", options.extras.insider),
		`Manage your settings: ${dashboardUrl}`,
		optOutSuffix,
	].filter((value) => Boolean(value));

	return sections.join("\n\n");
}

/**
 * Format the daily digest payload for email delivery.
 *
 * Produces a plain-text version for logging and a simple HTML version for rendering.
 */
function formatDailyDigestEmail(options: {
	user: { id: string; email: string };
	userStocks: UserStockRow[];
	extras: SmsExtras;
}): { subject: string; text: string; html: string } {
	const tickers = options.userStocks.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "Tickers: (none)";
	const urls = buildEmailUrls(
		options.user.id,
		options.user.email,
		"dailyNotifications",
	);

	const news = (options.extras.news ?? "").trim();
	const rumors = (options.extras.rumors ?? "").trim();
	const analyst = (options.extras.analyst ?? "").trim();
	const insider = (options.extras.insider ?? "").trim();

	const sectionsText = [
		"Daily digest",
		tickersLine,
		news ? `\n🗞️ News\n${news}` : "",
		rumors ? `\n🤫 Rumors\n${rumors}` : "",
		analyst ? `\n📊 Analyst Consensus\n${analyst}` : "",
		insider ? `\n🏦 Insider Trades\n${insider}` : "",
		`\nManage your settings: ${urls.dashboardUrl}`,
		`Manage your delivery schedule: ${urls.scheduleUrl}`,
		`Unsubscribe: ${urls.unsubscribeUrl}`,
	].filter(Boolean);

	const subject = "Daily stock digest";
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
		<p style="margin: 0 0 16px; color: #6b7280; font-size: 14px;">${escapeHtml(tickersLine)}</p>
		${renderEmailSection("🗞️", "News", news, { showGrokLogo: true, showFinnhubLogo: true })}
		${renderEmailSection("🤫", "Rumors", rumors, { showGrokLogo: true })}
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
	userStocks: UserStockRow[];
	extras: SmsExtras;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userStocks,
		extras,
		sendEmail,
		stats,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily_digest",
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
	const message = formatDailyDigestEmail({ user, userStocks, extras });
	const result = await sendUserEmail(
		user,
		message.subject,
		{ text: message.text, html: message.html },
		sendEmail,
		emailIdempotencyKey,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily_digest",
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
		notificationType: "daily_digest",
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
	userStocks: UserStockRow[];
	extras: SmsExtras;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userStocks,
		extras,
		getSmsSender,
		stats,
	} = options;

	if (!shouldSendSms(user)) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily_digest",
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
			notificationType: "daily_digest",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});
		return;
	}

	const smsMessage = formatDailyDigestSmsMessage({ userStocks, extras });
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily_digest",
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
		notificationType: "daily_digest",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
