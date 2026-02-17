import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { renderEmailSection } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import {
	buildMarketClosedBannerHtml,
	buildMarketClosedBannerText,
} from "../messaging/market-closure-banner";
import { recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { UserRecord } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../schedule/helpers";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import type { MarketClosureInfo } from "../time/market-calendar";

/* =============
SMS formatting
============= */

/** Build the SMS body for an asset-events digest. */
function formatAssetEventsSmsMessage(options: {
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
}): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const parts: string[] = ["StockTextAlerts — Asset Events 🗓️"];

	if (options.marketClosureInfo) {
		parts.push(
			buildMarketClosedBannerText(options.marketClosureInfo, "events"),
		);
	}

	if (options.earningsSection) {
		parts.push(`📅 Earnings\n${options.earningsSection}`);
	}
	if (options.dividendsSection) {
		parts.push(`💰 Ex-Dividend\n${options.dividendsSection}`);
	}
	if (options.splitsSection) {
		parts.push(`✂️ Splits\n${options.splitsSection}`);
	}
	if (options.iposSection) {
		parts.push(`🆕 Upcoming IPOs\n${options.iposSection}`);
	}
	if (options.insiderSection) {
		parts.push(`🏦 Insider Trades\n${options.insiderSection}`);
	}
	if (options.analystSection) {
		parts.push(
			`📊 Analyst Consensus (published monthly on the 1st)\n${options.analystSection}`,
		);
	}

	parts.push(`Manage your settings: ${dashboardUrl}`);
	parts.push(optOutSuffix);

	return parts.join("\n\n");
}

/* =============
Email formatting
============= */

/** Build the email payload (subject/text/html) for an asset-events digest. */
function formatAssetEventsEmail(options: {
	user: { id: string; email: string };
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
}): { subject: string; text: string; html: string } {
	const urls = buildEmailUrls(
		options.user.id,
		options.user.email,
		"assetEvents",
	);

	const textParts: string[] = ["Asset Events"];

	if (options.marketClosureInfo) {
		textParts.push(
			buildMarketClosedBannerText(options.marketClosureInfo, "events"),
		);
	}

	if (options.earningsSection) {
		textParts.push(`\n📅 Earnings\n${options.earningsSection}`);
	}
	if (options.dividendsSection) {
		textParts.push(`\n💰 Ex-Dividend Dates\n${options.dividendsSection}`);
	}
	if (options.splitsSection) {
		textParts.push(`\n✂️ Stock Splits\n${options.splitsSection}`);
	}
	if (options.iposSection) {
		textParts.push(`\n🆕 Upcoming IPOs\n${options.iposSection}`);
	}
	if (options.insiderSection) {
		textParts.push(`\n🏦 Insider Trades\n${options.insiderSection}`);
	}
	if (options.analystSection) {
		textParts.push(
			`\n📊 Analyst Consensus (published monthly on the 1st)\n${options.analystSection}`,
		);
	}
	textParts.push(`\nManage your settings: ${urls.dashboardUrl}`);
	textParts.push(`Manage your delivery schedule: ${urls.scheduleUrl}`);
	textParts.push(`Unsubscribe: ${urls.unsubscribeUrl}`);

	const subject = "Asset Events";
	const text = textParts.join("\n");

	const marketClosedHtml = options.marketClosureInfo
		? buildMarketClosedBannerHtml(options.marketClosureInfo, "events")
		: "";

	let sectionsHtml = "";
	if (options.earningsSection) {
		sectionsHtml += renderEmailSection(
			"📅",
			"Earnings",
			options.earningsSection,
		);
	}
	if (options.dividendsSection) {
		sectionsHtml += renderEmailSection(
			"💰",
			"Ex-Dividend Dates",
			options.dividendsSection,
		);
	}
	if (options.splitsSection) {
		sectionsHtml += renderEmailSection(
			"✂️",
			"Stock Splits",
			options.splitsSection,
		);
	}
	if (options.iposSection) {
		sectionsHtml += renderEmailSection(
			"🆕",
			"Upcoming IPOs",
			options.iposSection,
		);
	}
	if (options.insiderSection) {
		sectionsHtml += renderEmailSection(
			"🏦",
			"Insider Trades",
			options.insiderSection,
			{ showFinnhubLogo: true },
		);
	}
	if (options.analystSection) {
		sectionsHtml += renderEmailSection(
			"📊",
			"Analyst Consensus (published monthly on the 1st)",
			options.analystSection,
			{ showFinnhubLogo: true },
		);
	}
	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 StockTextAlerts</h1>
	</div>
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${marketClosedHtml}
		<h2 style="margin: 0 0 8px; font-size: 18px;">Asset Events</h2>
		<p style="margin: 0 0 16px; color: #6b7280; font-size: 14px;">Upcoming events for your tracked assets</p>
		${sectionsHtml}
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

/* =============
Delivery: Email
============= */

/** Deliver an asset-events digest via email and record the attempt. */
export async function processAssetEventsEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		sendEmail,
		stats,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
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

	const emailIdempotencyKey = `asset-events/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const message = formatAssetEventsEmail({
		user,
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		marketClosureInfo: options.marketClosureInfo,
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
		type: "asset_events",
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
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}

/* =============
Delivery: SMS
============= */

/** Deliver an asset-events digest via SMS and record the attempt. */
export async function processAssetEventsSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		getSmsSender,
		stats,
	} = options;

	if (!shouldSendSms(user)) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
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
			"Failed to resolve SMS sender for asset events",
			{ userId: user.id, scheduledDate, scheduledMinutes, errorMessage },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "asset_events",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});
		return;
	}

	const smsMessage = formatAssetEventsSmsMessage({
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		marketClosureInfo: options.marketClosureInfo,
	});
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "asset_events",
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
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
