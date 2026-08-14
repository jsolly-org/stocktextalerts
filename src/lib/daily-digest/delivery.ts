import type { AssetEventsContent } from "../asset-events/types";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { wantsTelegramDelivery } from "../messaging/delivery-channel";
import { sendUserEmail } from "../messaging/email/index";
import {
	formatDailyDigestEmail,
	formatDailyDigestTelegram,
} from "../messaging/notifications/daily-digest";
import type { SparklineMap } from "../messaging/parts/sparkline";
import {
	claimScheduledChannel,
	completeScheduledChannelFromResult,
	reserveScheduledChannelBudget,
	resolveScheduledSender,
} from "../messaging/scheduled-channel";
import { buildDashboardButton } from "../messaging/telegram/dashboard-button";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender, NotificationExtras } from "../messaging/types";
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

type AssetEventsResult = AssetEventsContent | null;

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

	const budgetReserved = await reserveScheduledChannelBudget({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
		stats,
		attemptCount,
	});
	if (!budgetReserved) {
		return;
	}

	const message = formatDailyDigestEmail({
		user,
		is24Hour: user.use_24_hour_time,
		timeZone: user.timezone,
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
		budgetReserved: true,
	});
}

/**
 * Deliver a daily digest via Telegram and record the result.
 *
 * Renders the Telegram-native digest (parse-mode entities), including prediction
 * markets as Unicode probability bars inline in the text (same structure as email
 * cards — Telegram cannot embed HTML/images mid-message). Oversized bodies are
 * packed into sequential sendMessage chunks (Telegram's 4096 UTF-16 cap). A later
 * retry after a partial multi-chunk send can duplicate already-delivered prefix
 * chunks — accepted at household scale; there is no per-chunk persistence.
 * Claims the `telegram` channel of the daily slot so it retries and advances
 * independently of email.
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
	marketClosureInfo?: MarketClosureInfo | null;
	is24Hour?: boolean;
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
		marketClosureInfo,
		is24Hour,
		sparklines,
		marketOpen,
		getTelegramSender,
		stats,
	} = options;

	// Re-check account routing so a concurrent /stop or unlink between content
	// prep and delivery is honored.
	if (!wantsTelegramDelivery(user)) {
		return;
	}
	const chatId = user.telegram_chat_id;
	if (chatId == null) {
		return;
	}

	const attemptCount = await claimScheduledChannel({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
	});
	if (attemptCount === null) {
		return;
	}

	const budgetReserved = await reserveScheduledChannelBudget({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
		attemptCount,
	});
	if (!budgetReserved) {
		return;
	}

	const telegramSenderResult = await resolveScheduledSender({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
		attemptCount,
		getSender: getTelegramSender,
		logMessage: "Failed to resolve Telegram sender for daily digest",
		budgetReserved: true,
	});
	if (telegramSenderResult === null) {
		return;
	}

	const timeZone = user.timezone;
	const use24Hour = is24Hour ?? user.use_24_hour_time;

	const chunks = formatDailyDigestTelegram({
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		dateLabel,
		delayBanner,
		marketClosureInfo,
		is24Hour: use24Hour,
		timeZone,
		sparklines,
		marketOpen,
	});
	const logMessage = chunks.map((chunk) => chunk.text).join("\n\n");
	const replyMarkup = buildDashboardButton("dailyNotifications");
	const logSendFailure = (
		failed: Extract<DeliveryResult, { success: false }>,
		textLength: number,
		chunkIndex: number,
	) => {
		logger.error(
			"Failed to send Daily Digest Telegram message",
			{
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				errorCode: failed.errorCode ?? null,
				textLength,
				chunkIndex,
				chunkCount: chunks.length,
			},
			new Error(failed.error ?? "Daily Digest Telegram send failed"),
		);
	};

	let result: DeliveryResult;
	if (chunks.length === 0) {
		result = { success: false, error: "Daily digest produced no Telegram text" };
		logSendFailure(result, 0, 0);
	} else {
		result = { success: true };
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];
			if (chunk === undefined) break;
			const isLast = chunkIndex === chunks.length - 1;
			result = await telegramSenderResult.sender({
				kind: "text",
				chatId,
				text: chunk.text,
				entities: chunk.entities,
				replyMarkup: isLast ? replyMarkup : undefined,
				// Routine scheduled digest — deliver silently like other passive updates.
				disableNotification: true,
			});
			if (!result.success) {
				logSendFailure(result, chunk.text.length, chunkIndex);
				break;
			}
		}
	}

	await optOutIfBotBlocked(supabase, user.id, result, logger);

	await completeScheduledChannelFromResult({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
		attemptCount,
		result,
		logMessage,
		budgetReserved: true,
	});
}
