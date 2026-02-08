import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import type { SmsExtras } from "../messaging/sms/delivery";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { escapeHtml } from "../messaging/stock-formatting";
import type { UserRecord, UserStockRow } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { logRetriesExhausted, updateScheduledNotificationRow } from "./helpers";
import type { SmsSenderProvider } from "./run-user-sms-sender";

function formatExtrasSection(
	title: string,
	content: string | null | undefined,
): string {
	const normalized = (content ?? "").trim();
	if (!normalized) {
		return "";
	}
	return `${title}\n${normalized}`;
}

function formatDailyAddOnsSmsMessage(options: {
	userStocks: UserStockRow[];
	extras: SmsExtras;
}): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const tickers = options.userStocks.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "";

	const sections = [
		"Daily add-ons",
		tickersLine,
		formatExtrasSection("🗞️ News", options.extras.news),
		formatExtrasSection("🤫 Rumors", options.extras.rumors),
		optOutSuffix,
	].filter((value) => Boolean(value));

	return sections.join("\n\n");
}
function formatDailyAddOnsEmail(options: {
	userStocks: UserStockRow[];
	extras: SmsExtras;
}): { subject: string; text: string; html: string } {
	const tickers = options.userStocks.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "Tickers: (none)";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const news = (options.extras.news ?? "").trim();
	const rumors = (options.extras.rumors ?? "").trim();

	const sectionsText = [
		"Daily add-ons",
		tickersLine,
		news ? `\n🗞️ News\n${news}` : "",
		rumors ? `\n🤫 Rumors\n${rumors}` : "",
		`\nManage settings: ${dashboardUrl}`,
	].filter(Boolean);

	const subject = "Daily stock add-ons";
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
		<h2 style="margin: 0 0 8px; font-size: 18px;">Daily add-ons</h2>
		<p style="margin: 0 0 16px; color: #6b7280; font-size: 14px;">${escapeHtml(tickersLine)}</p>
		${news ? `<h3 style="margin: 16px 0 6px; font-size: 14px;">🗞️ News</h3><pre style="white-space: pre-wrap; margin: 0; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${escapeHtml(news)}</pre>` : ""}
		${rumors ? `<h3 style="margin: 16px 0 6px; font-size: 14px;">🤫 Rumors</h3><pre style="white-space: pre-wrap; margin: 0; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${escapeHtml(rumors)}</pre>` : ""}
		<p style="margin: 18px 0 0; font-size: 12px; color: #6b7280;">
			<a href="${escapeHtml(dashboardUrl)}" style="color: #667eea; text-decoration: none;">Manage settings</a>
		</p>
	</div>
</body>
</html>`;

	return { subject, text, html };
}
export async function processDailyAddOnsEmailDelivery(options: {
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

	const { data: claimed, error: claimError } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_scheduled_notification", {
		p_user_id: user.id,
		p_notification_type: "daily_add_ons",
		p_scheduled_date: scheduledDate,
		p_scheduled_minutes: scheduledMinutes,
		p_channel: "email",
	});

	if (claimError) {
		logger.error(
			"Failed to claim daily add-ons notification (email)",
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
			notificationType: "daily_add_ons",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
		});
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `daily-add-ons/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const message = formatDailyAddOnsEmail({ userStocks, extras });
	const result = await sendUserEmail(
		user,
		message.subject,
		{ text: message.text, html: message.html },
		sendEmail,
		emailIdempotencyKey,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily_add_ons",
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
		notificationType: "daily_add_ons",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
export async function processDailyAddOnsSmsDelivery(options: {
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

	const { data: claimed, error: claimError } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_scheduled_notification", {
		p_user_id: user.id,
		p_notification_type: "daily_add_ons",
		p_scheduled_date: scheduledDate,
		p_scheduled_minutes: scheduledMinutes,
		p_channel: "sms",
	});

	if (claimError) {
		logger.error(
			"Failed to claim daily add-ons notification (sms)",
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
			notificationType: "daily_add_ons",
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
			"Failed to resolve SMS sender for daily add-ons",
			{ userId: user.id, scheduledDate, scheduledMinutes, errorMessage },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "daily_add_ons",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});
		return;
	}

	const smsMessage = formatDailyAddOnsSmsMessage({ userStocks, extras });
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily_add_ons",
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
		notificationType: "daily_add_ons",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
