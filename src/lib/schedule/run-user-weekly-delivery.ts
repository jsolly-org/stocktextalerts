import { DASHBOARD_SECTION_HASHES } from "../constants";
import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { createEmailUnsubscribeUrl } from "../messaging/email/email-unsubscribe";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { escapeHtml } from "../messaging/stock-formatting";
import type { UserRecord } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { logRetriesExhausted, updateScheduledNotificationRow } from "./helpers";
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
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const escapedDashboardUrl = escapeHtml(dashboardUrl);
	const scheduleUrl = `${dashboardUrl}${DASHBOARD_SECTION_HASHES.occasionalNotifications}`;
	const escapedScheduleUrl = escapeHtml(scheduleUrl);
	const unsubscribeUrl = createEmailUnsubscribeUrl({
		userId: options.user.id,
		email: options.user.email,
	});
	const escapedUnsubscribeUrl = escapeHtml(unsubscribeUrl);

	const earnings = (options.earningsSection ?? "").trim();
	const dividends = (options.dividendsSection ?? "").trim();

	const sectionsText = [
		"Weekly calendar",
		earnings ? `\n📅 Earnings This Week\n${earnings}` : "",
		dividends ? `\n💰 Dividends\n${dividends}` : "",
		`\nManage your settings: ${dashboardUrl}`,
		`Manage your delivery schedule: ${scheduleUrl}`,
		`Unsubscribe from email notifications: ${unsubscribeUrl}`,
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
		${earnings ? `<h3 style="margin: 16px 0 6px; font-size: 14px;">📅 Earnings This Week</h3><pre style="white-space: pre-wrap; margin: 0; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${escapeHtml(earnings)}</pre>` : ""}
		${dividends ? `<h3 style="margin: 16px 0 6px; font-size: 14px;">💰 Dividends</h3><pre style="white-space: pre-wrap; margin: 0; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${escapeHtml(dividends)}</pre>` : ""}
		<div style="text-align: center; margin-top: 20px;">
			<a href="${escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your settings →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
			<a href="${escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Adjust delivery schedule</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from email</a>
		</p>
	</div>
</body>
</html>`;

	return { subject, text, html };
}

/* =============
Delivery: Email
============= */

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

	const { data: claimed, error: claimError } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_scheduled_notification", {
		p_user_id: user.id,
		p_notification_type: "weekly_calendar",
		p_scheduled_date: scheduledDate,
		p_scheduled_minutes: scheduledMinutes,
		p_channel: "email",
	});

	if (claimError) {
		logger.error(
			"Failed to claim weekly calendar notification (email)",
			{ userId: user.id },
			claimError,
		);
		stats.emailsFailed++;
		return;
	}
	if (!claimed) {
		await logRetriesExhausted({
			supabase,
			userId: user.id,
			notificationType: "weekly_calendar",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
		});
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

	const { data: claimed, error: claimError } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_scheduled_notification", {
		p_user_id: user.id,
		p_notification_type: "weekly_calendar",
		p_scheduled_date: scheduledDate,
		p_scheduled_minutes: scheduledMinutes,
		p_channel: "sms",
	});

	if (claimError) {
		logger.error(
			"Failed to claim weekly calendar notification (sms)",
			{ userId: user.id },
			claimError,
		);
		stats.smsFailed++;
		return;
	}
	if (!claimed) {
		await logRetriesExhausted({
			supabase,
			userId: user.id,
			notificationType: "weekly_calendar",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			logger,
		});
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
