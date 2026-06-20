import type { Logger } from "../../logging";
import { createErrorForLogging, extractErrorMessage } from "../../logging/errors";
import { processEmailUpdate } from "../../messaging/email/delivery";
import type { EmailSender } from "../../messaging/email/utils";
import { deliveryResultToLogFields, recordNotification } from "../../messaging/shared";
import { processSmsUpdate } from "../../messaging/sms/delivery";
import type { SparklineData } from "../../messaging/sparkline";
import { formatMarketScheduledTelegram } from "../../messaging/telegram/market-scheduled";
import { optOutIfBotBlocked } from "../../messaging/telegram/opt-out";
import type { UserAssetRow, UserRecord } from "../../messaging/types";
import type { AssetPriceMap, MarketSession } from "../../providers/price-fetcher";
import type { ScheduledNotificationTotals, SupabaseAdminClient } from "../../schedule/helpers";
import { claimNotification, updateScheduledNotificationRow } from "../../schedule/helpers";
import type { SmsSenderProvider } from "../../schedule/sms-sender";
import type { TelegramSenderProvider } from "../../schedule/telegram-sender";
import type { MarketClosureInfo } from "../../time/market-calendar";

/**
 * Deliver a scheduled market asset update via email and record the result.
 *
 * Uses `claim_scheduled_notification` for idempotency, then writes the final status to
 * `scheduled_notifications` and logs a notification row.
 */
export async function processMarketScheduledEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetsList: string;
	sendEmail: EmailSender;
	priceMap: AssetPriceMap;
	noSessionTrade?: Set<string>;
	marketSession: MarketSession;
	marketClosureInfo?: MarketClosureInfo | null;
	stats: ScheduledNotificationTotals;
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
	getLogoHtml?: (symbol: string) => string | undefined;
	delayBanners?: { text?: string | null; html?: string | null };
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	};
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		assetsList,
		sendEmail,
		priceMap,
		noSessionTrade,
		marketSession,
		marketClosureInfo,
		stats,
		getSparkline,
		getLogoHtml,
		sessionFirstLine,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.emailsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `scheduled-update/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const { sent, logged, error } = await processEmailUpdate(
		supabase,
		user,
		userAssets,
		assetsList,
		sendEmail,
		priceMap,
		marketSession,
		emailIdempotencyKey,
		{ getSparkline, marketClosureInfo, getLogoHtml },
		options.delayBanners,
		sessionFirstLine,
		noSessionTrade,
	);

	if (sent) {
		stats.emailsSent++;
	} else {
		stats.emailsFailed++;
	}

	if (!logged) {
		stats.logFailures++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}

/**
 * Deliver a scheduled market asset update via SMS and record the result.
 *
 * Uses `claim_scheduled_notification` for idempotency. SMS sender initialization can fail
 * (e.g. missing Twilio config); that failure is recorded and the notification is marked failed.
 */
export async function processMarketScheduledSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetsList: string;
	getSmsSender: SmsSenderProvider;
	marketSession: MarketSession;
	marketClosureInfo?: MarketClosureInfo | null;
	stats: ScheduledNotificationTotals;
	/** Optional delay banner text for late notifications. */
	delayBanner?: string | null;
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	};
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		assetsList,
		getSmsSender,
		marketSession,
		marketClosureInfo,
		stats,
		sessionFirstLine,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "market",
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

	let smsSenderResult: ReturnType<SmsSenderProvider>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender",
			{
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				channel: "sms",
				stats,
			},
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "market",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "market",
			delivery_method: "sms",
			message_delivered: false,
			message: "SMS service unavailable",
			error: errorMessage,
		});
		if (!logged) {
			stats.logFailures++;
		}

		return;
	}
	const smsSender = smsSenderResult.sender;

	const { sent, logged, error } = await processSmsUpdate(
		supabase,
		user,
		assetsList,
		smsSender,
		marketSession,
		undefined,
		marketClosureInfo,
		options.delayBanner,
		sessionFirstLine,
	);

	if (sent) {
		stats.smsSent++;
	} else {
		stats.smsFailed++;
	}

	if (!logged) {
		stats.logFailures++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}

/**
 * Deliver a scheduled market asset update via Telegram and record the result.
 *
 * Mirrors `processMarketScheduledSmsDelivery`: claims the `telegram` channel of the
 * market slot (so it retries/advances independently of email/SMS) and renders the
 * Telegram-native multi-asset price snapshot (parse-mode entities, no chart). Channel
 * usability is re-checked by the caller; the per-option Telegram pref gate runs in
 * process.ts before this is invoked.
 */
export async function processMarketScheduledTelegramDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	priceMap: AssetPriceMap;
	sessionLabel?: string | null;
	marketClosedBanner?: string | null;
	getTelegramSender: TelegramSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		priceMap,
		sessionLabel,
		marketClosedBanner,
		getTelegramSender,
		stats,
	} = options;

	if (user.telegram_chat_id == null) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "market",
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

	let telegramSenderResult: ReturnType<TelegramSenderProvider>;
	try {
		telegramSenderResult = getTelegramSender();
	} catch (error) {
		stats.telegramFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve Telegram sender for scheduled market update",
			{ userId: user.id, scheduledDate, scheduledMinutes },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "market",
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
			status: "failed",
			error: errorMessage,
			logger,
		});
		return;
	}

	const formatted = formatMarketScheduledTelegram({
		userAssets,
		assetPrices: priceMap,
		sessionLabel,
		marketClosedBanner,
	});

	const result = await telegramSenderResult.sender({
		chatId: user.telegram_chat_id,
		text: formatted.text,
		entities: formatted.entities,
		// Routine scheduled update — deliver silently like other passive updates.
		disableNotification: true,
	});

	if (!result.success) {
		logger.error(
			"Failed to send scheduled market Telegram message",
			{ userId: user.id, scheduledDate, scheduledMinutes, errorCode: result.errorCode ?? null },
			new Error(result.error ?? "Scheduled market Telegram send failed"),
		);
	}

	await optOutIfBotBlocked(supabase, user.id, result, logger);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "market",
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
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		logger,
	});
}
