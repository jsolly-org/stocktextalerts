import type { AssetEventsResult } from "../asset-events/types";
import type { SupabaseAdminClient } from "../db/supabase";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import type { Logger } from "../logging/types";
import {
	claimScheduledChannel,
	completeScheduledChannelFromResult,
} from "../messaging/delivery/scheduled-channel";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/types";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsLogMessage,
	formatDailyDigestSmsMessage,
	formatDailyDigestSmsMessages,
	formatDailyDigestTelegram,
	formatDigestQuoteAsOf,
	summarizeDailyDigestSmsResults,
} from "../messaging/notifications/daily-digest";
import type { SparklineMap } from "../messaging/parts/charts/sparkline";
import { deliveryResultToLogFields, recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { SmsSenderFactory } from "../messaging/sms/types";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { TelegramSenderFactory } from "../messaging/telegram/types";
import type { NotificationExtras } from "../messaging/types";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../scheduled-notifications/store";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import type { MarketClosureInfo } from "../time/types";
import type {
	AssetPriceMap,
	DeliveryResult,
	IsoDateString,
	MinuteOfDay,
	UserAssetRow,
	UserRecord,
} from "../types";

export {
	formatDailyDigestEmail,
	formatDailyDigestSmsLogMessage,
	formatDailyDigestSmsMessage,
	formatDailyDigestSmsMessages,
	formatDigestQuoteAsOf,
	summarizeDailyDigestSmsResults,
};

/** Deliver a daily digest via email and record the result. */
export async function processDailyDigestEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: NotificationExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
	getLogoHtml?: (symbol: string) => string | undefined;
	delayBannerText?: string | null;
	delayBannerHtml?: string | null;
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
		sendEmail,
		stats,
	} = options;

	const attemptCount = await claimScheduledChannel({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
		stats,
	});
	if (attemptCount === null) {
		return;
	}

	const message = formatDailyDigestEmail({
		user,
		is24Hour: user.use_24_hour_time,
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		sparklines: options.sparklines,
		marketOpen: options.marketOpen,
		marketClosureInfo: options.marketClosureInfo,
		getLogoHtml: options.getLogoHtml,
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
		notificationType: "daily",
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

/** Deliver a daily digest via SMS and record the result. */
export async function processDailyDigestSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: NotificationExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
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
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return;
	}

	let smsSenderResult: ReturnType<SmsSenderFactory>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender for daily digest",
			{ userId: user.id, scheduledDate, scheduledMinutes },
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
			attemptCount: claim.attemptCount,
			logger,
		});
		return;
	}

	const smsMessages = formatDailyDigestSmsMessages({
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		sparklines: options.sparklines,
		marketOpen: options.marketOpen,
		marketClosureInfo: options.marketClosureInfo,
		is24Hour: user.use_24_hour_time,
		delayBanner: options.delayBanner,
	});
	const partResults: DeliveryResult[] = [];
	for (const [index, smsMessage] of smsMessages.entries()) {
		const partResult = await sendUserSms(user, smsMessage, smsSenderResult.sender, supabase);
		partResults.push(partResult);

		if (!partResult.success) {
			logger.error(
				"Failed to send Daily Digest SMS part",
				{
					userId: user.id,
					scheduledDate,
					scheduledMinutes,
					partNumber: index + 1,
					totalParts: smsMessages.length,
					partLength: smsMessage.length,
					errorCode: partResult.errorCode ?? null,
				},
				new Error(partResult.error ?? "Daily Digest SMS part failed"),
			);
			break;
		}
	}

	const result = summarizeDailyDigestSmsResults(partResults, smsMessages.length);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "sms",
		message_delivered: result.success,
		message: formatDailyDigestSmsLogMessage(smsMessages),
		...deliveryResultToLogFields(result),
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
		attemptCount: claim.attemptCount,
		logger,
	});
}

/**
 * Deliver a daily digest via Telegram and record the result.
 *
 * Mirrors `processDailyDigestSmsDelivery` but renders the Telegram-native digest
 * (parse-mode entities, no SMS segment limit) and sends a single message via the
 * Telegram sender. v1 content is prices (+ top movers when the user enabled that
 * facet for Telegram); Grok news/rumors are intentionally omitted from `extras`
 * by the caller. Claims the `telegram` channel of the daily slot so it retries
 * and advances independently of email/SMS.
 */
export async function processDailyDigestTelegramDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: NotificationExtras;
	assetEvents?: AssetEventsResult;
	/** Human date label in market tz, e.g. "Thu, Jun 19". */
	dateLabel: string;
	delayBanner?: string | null;
	marketClosedBanner?: string | null;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
	getTelegramSender: TelegramSenderFactory;
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
		dateLabel,
		delayBanner,
		marketClosedBanner,
		sparklines,
		marketOpen,
		getTelegramSender,
		stats,
	} = options;

	// Channel usability is re-checked here (chat linked + not opted out) so a
	// concurrent opt-out between content prep and delivery is honored.
	if (!isTelegramChannelUsable(user) || user.telegram_chat_id == null) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.telegramFailed++;
		return;
	}
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return;
	}

	let telegramSenderResult: ReturnType<TelegramSenderFactory>;
	try {
		telegramSenderResult = getTelegramSender();
	} catch (error) {
		stats.telegramFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve Telegram sender for daily digest",
			{ userId: user.id, scheduledDate, scheduledMinutes },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
			status: "failed",
			error: errorMessage,
			attemptCount: claim.attemptCount,
			logger,
		});
		return;
	}

	const formatted = formatDailyDigestTelegram({
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		dateLabel,
		delayBanner,
		marketClosedBanner,
		sparklines,
		marketOpen,
	});

	const result = await telegramSenderResult.sender({
		chatId: user.telegram_chat_id,
		text: formatted.text,
		entities: formatted.entities,
		// Routine scheduled digest — deliver silently like other passive updates.
		disableNotification: true,
	});

	if (!result.success) {
		logger.error(
			"Failed to send Daily Digest Telegram message",
			{
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				errorCode: result.errorCode ?? null,
			},
			new Error(result.error ?? "Daily Digest Telegram send failed"),
		);
	}

	await optOutIfBotBlocked(supabase, user.id, result, logger);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "telegram",
		message_delivered: result.success,
		message: formatted.text,
		...deliveryResultToLogFields(result),
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (result.success) {
		stats.telegramSent++;
	} else {
		stats.telegramFailed++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		attemptCount: claim.attemptCount,
		logger,
	});
}
