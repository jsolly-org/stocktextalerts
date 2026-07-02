import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { sendUserEmail } from "../messaging/email/index";
import {
	formatAssetEventsEmail,
	formatAssetEventsSms,
	formatAssetEventsTelegram,
} from "../messaging/notifications/asset-events";
import {
	claimScheduledChannel,
	completeScheduledChannelFromResult,
} from "../messaging/scheduled-channel";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { SmsSenderFactory } from "../messaging/sms/sender-factory";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender } from "../messaging/types";
import { updateScheduledNotificationRow } from "../scheduled-notifications/store";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import type { MarketClosureInfo } from "../time/types";
import type { IsoDateString, MinuteOfDay, UserRecord } from "../types";

/* =============
Delivery: Email
============= */

/** Deliver an asset-events digest via email and record the attempt. */
export async function processAssetEventsEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
	delayBannerText?: string | null;
	delayBannerHtml?: string | null;
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

	const attemptCount = await claimScheduledChannel({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
		stats,
	});
	if (attemptCount === null) {
		return;
	}

	const message = formatAssetEventsEmail({
		user,
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		marketClosureInfo: options.marketClosureInfo,
		delayBannerText: options.delayBannerText,
		delayBannerHtml: options.delayBannerHtml,
	});
	const result = await sendUserEmail(
		user,
		message.subject,
		{ text: message.text, html: message.html },
		sendEmail,
	);

	await completeScheduledChannelFromResult({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
		stats,
		attemptCount,
		result,
		logMessage: message.text,
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
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	getSmsSender: SmsSenderFactory;
	stats: ScheduledNotificationTotals;
	/** Optional delay banner text for late notifications. */
	delayBanner?: string | null;
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

	const attemptCount = await claimScheduledChannel({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		logger,
		stats,
	});
	if (attemptCount === null) {
		return;
	}

	let smsSenderResult: ReturnType<SmsSenderFactory>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender for asset events",
			{ userId: user.id, scheduledDate, scheduledMinutes },
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
			attemptCount,
			logger,
		});
		return;
	}

	const smsMessage = formatAssetEventsSms({
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		marketClosureInfo: options.marketClosureInfo,
		delayBanner: options.delayBanner,
	});
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender, supabase);
	await completeScheduledChannelFromResult({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		logger,
		stats,
		attemptCount,
		result,
		logMessage: smsMessage,
	});
}

/* =============
Delivery: Telegram
============= */

/**
 * Deliver a standalone asset-events digest via Telegram and record the attempt.
 *
 * Mirrors `processAssetEventsSmsDelivery`: claims the `telegram` channel of the
 * asset-events slot (retries/advances independently of email/SMS) and renders the
 * Telegram-native digest (parse-mode entities, no chart). The caller filters the
 * sections to only the user's Telegram-enabled facets before this is invoked.
 */
export async function processAssetEventsTelegramDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	delayBanner?: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	getTelegramSender: TelegramSenderFactory;
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
		delayBanner,
		getTelegramSender,
		stats,
	} = options;

	if (user.telegram_chat_id == null) {
		return;
	}

	const attemptCount = await claimScheduledChannel({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
	});
	if (attemptCount === null) {
		return;
	}

	let telegramSenderResult: ReturnType<TelegramSenderFactory>;
	try {
		telegramSenderResult = getTelegramSender();
	} catch (error) {
		stats.telegramFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve Telegram sender for asset events",
			{ userId: user.id, scheduledDate, scheduledMinutes },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "asset_events",
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
			status: "failed",
			error: errorMessage,
			attemptCount,
			logger,
		});
		return;
	}

	const formatted = formatAssetEventsTelegram({
		earningsSection,
		dividendsSection,
		splitsSection,
		iposSection,
		analystSection,
		insiderSection,
		delayBanner,
		marketClosureInfo: options.marketClosureInfo,
	});

	const result = await telegramSenderResult.sender({
		chatId: user.telegram_chat_id,
		text: formatted.text,
		entities: formatted.entities,
		// Routine scheduled events digest — deliver silently.
		disableNotification: true,
	});

	if (!result.success) {
		logger.error(
			"Failed to send asset-events Telegram message",
			{ userId: user.id, scheduledDate, scheduledMinutes, errorCode: result.errorCode ?? null },
			new Error(result.error ?? "Asset events Telegram send failed"),
		);
	}

	await optOutIfBotBlocked(supabase, user.id, result, logger);

	await completeScheduledChannelFromResult({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
		attemptCount,
		result,
		logMessage: formatted.text,
	});
}
