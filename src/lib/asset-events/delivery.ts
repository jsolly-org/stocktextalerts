import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { sendUserEmail } from "../messaging/email/index";
import {
	formatAssetEventsEmail,
	formatAssetEventsTelegram,
} from "../messaging/notifications/asset-events";
import {
	claimScheduledChannel,
	completeScheduledChannelFromResult,
	reserveScheduledChannelBudget,
	resolveScheduledSender,
} from "../messaging/scheduled-channel";
import { buildDashboardButton } from "../messaging/telegram/dashboard-button";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender } from "../messaging/types";
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

	const budgetReserved = await reserveScheduledChannelBudget({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
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
		budgetReserved: true,
	});
}

/* =============
Delivery: Telegram
============= */

/**
 * Deliver a standalone asset-events digest via Telegram and record the attempt.
 *
 * Claims the `telegram` channel of the asset-events slot (retries/advances
 * independently of email) and renders the Telegram-native digest (parse-mode
 * entities, no chart). The caller filters the sections to only the user's
 * Telegram-enabled facets before this is invoked.
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

	const budgetReserved = await reserveScheduledChannelBudget({
		supabase,
		userId: user.id,
		notificationType: "asset_events",
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
		notificationType: "asset_events",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
		stats,
		attemptCount,
		getSender: getTelegramSender,
		logMessage: "Failed to resolve Telegram sender for asset events",
		budgetReserved: true,
	});
	if (telegramSenderResult === null) {
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
		replyMarkup: buildDashboardButton("assetEvents"),
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
		budgetReserved: true,
	});
}
