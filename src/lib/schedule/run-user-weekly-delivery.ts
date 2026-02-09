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
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { UserRecord } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { claimNotification, updateScheduledNotificationRow } from "./helpers";
import type { SmsSenderProvider } from "./run-user-sms-sender";

/* =============
SMS formatting
============= */

function formatWeeklyCalendarSmsMessage(options: {
	earningsSection: string | null;
	dividendsSection: string | null;
}): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const sections = [
		"StockTextAlerts — Weekly calendar",
		options.earningsSection
			? `📅 Earnings This Week\n${options.earningsSection}`
			: "",
		options.dividendsSection ? `💰 Dividends\n${options.dividendsSection}` : "",
		`Manage your settings: ${dashboardUrl}`,
		optOutSuffix,
	].filter(Boolean);

	return sections.join("\n\n");
}

/* =============
Email formatting
============= */

function formatWeeklyCalendarEmail(options: {
	user: { id: string; email: string };
	earningsSection: string | null;
	dividendsSection: string | null;
}): { subject: string; text: string; html: string } {
	const urls = buildEmailUrls(
		options.user.id,
		options.user.email,
		"occasionalNotifications",
	);

	const earnings = (options.earningsSection ?? "").trim();
	const dividends = (options.dividendsSection ?? "").trim();

	const sectionsText = [
		"Weekly calendar",
		earnings ? `\n📅 Earnings This Week\n${earnings}` : "",
		dividends ? `\n💰 Dividends\n${dividends}` : "",
		`\nManage your settings: ${urls.dashboardUrl}`,
		`Manage your delivery schedule: ${urls.scheduleUrl}`,
		`Unsubscribe from email notifications: ${urls.unsubscribeUrl}`,
	].filter(Boolean);

	const subject = "Weekly calendar events";
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
		<h2 style="margin: 0 0 8px; font-size: 18px;">Weekly calendar</h2>
		<p style="margin: 0 0 16px; color: #6b7280; font-size: 14px;">Upcoming events for your tracked stocks</p>
		${renderEmailSection("📅", "Earnings This Week", earnings)}
		${renderEmailSection("💰", "Dividends", dividends)}
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

/**
 * Deliver a weekly calendar notification via email and record the result.
 *
 * Uses the `claim_scheduled_notification` RPC to ensure idempotent delivery across retries
 * and parallel runners, then writes a `scheduled_notifications` status update.
 */
export async function processWeeklyCalendarEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	earningsSection: string | null;
	dividendsSection: string | null;
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
		sendEmail,
		stats,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "weekly_calendar",
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

	const emailIdempotencyKey = `weekly-calendar/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const message = formatWeeklyCalendarEmail({
		user,
		earningsSection,
		dividendsSection,
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
		type: "weekly_calendar",
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
		notificationType: "weekly_calendar",
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

/**
 * Deliver a weekly calendar notification via SMS and record the result.
 *
 * Uses the `claim_scheduled_notification` RPC for idempotency. If the user is opted out or
 * lacks SMS capability, the function returns without delivery.
 */
export async function processWeeklyCalendarSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	earningsSection: string | null;
	dividendsSection: string | null;
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
		getSmsSender,
		stats,
	} = options;

	if (!shouldSendSms(user)) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "weekly_calendar",
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
			"Failed to resolve SMS sender for weekly calendar",
			{ userId: user.id, scheduledDate, scheduledMinutes, errorMessage },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "weekly_calendar",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});
		return;
	}

	const smsMessage = formatWeeklyCalendarSmsMessage({
		earningsSection,
		dividendsSection,
	});
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "weekly_calendar",
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
		notificationType: "weekly_calendar",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
