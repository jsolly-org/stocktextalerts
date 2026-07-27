import type { buildAssetEventsContent } from "../asset-events/content";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
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
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import { buildPredictionMarketCardSvg } from "../messaging/telegram/prediction-market-card";
import { renderChartPng } from "../messaging/telegram/render-png";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender, NotificationExtras, TelegramSender } from "../messaging/types";
import { formatPredictionMarketCardCaption } from "../prediction-markets/format";
import type { PredictionMarketEventCard } from "../prediction-markets/types";
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

type AssetEventsResult = Awaited<ReturnType<typeof buildAssetEventsContent>> | null;

/** Max prediction-market PNGs per digest (Lambda time + Telegram rate limits). */
const MAX_PREDICTION_MARKET_PHOTOS = 8;

type PredictionMarketPhoto = {
	card: PredictionMarketEventCard;
	photo: Buffer;
};

async function renderPredictionMarketPhotos(options: {
	cards: readonly PredictionMarketEventCard[];
	timeZone: string;
	use24Hour: boolean;
	logger: Logger;
	userId: string;
}): Promise<PredictionMarketPhoto[]> {
	const { cards, timeZone, use24Hour, logger, userId } = options;
	const out: PredictionMarketPhoto[] = [];
	for (const card of cards) {
		if (out.length >= MAX_PREDICTION_MARKET_PHOTOS) break;
		const svg = buildPredictionMarketCardSvg(card, { timeZone, use24Hour });
		if (svg === "") continue;
		const photo = await renderChartPng(svg);
		if (photo === null) {
			logger.warn("Prediction market card PNG render failed", {
				userId,
				marketKey: card.key,
				symbol: card.symbol ?? null,
			});
			continue;
		}
		out.push({ card, photo });
	}
	return out;
}

async function sendPredictionMarketPhotos(options: {
	sender: TelegramSender;
	chatId: number;
	photos: readonly PredictionMarketPhoto[];
	logger: Logger;
	userId: string;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
}): Promise<DeliveryResult | null> {
	const { sender, chatId, photos, logger, userId, scheduledDate, scheduledMinutes } = options;
	let blockedResult: DeliveryResult | null = null;
	for (const { card, photo } of photos) {
		const caption = formatPredictionMarketCardCaption(card);
		const result = await sender({
			chatId,
			text: caption.text,
			entities: caption.entities,
			photo,
			disableNotification: true,
		});
		if (!result.success) {
			logger.warn("Failed to send prediction market card photo", {
				userId,
				scheduledDate,
				scheduledMinutes,
				marketKey: card.key,
				errorCode: result.errorCode ?? null,
				error: result.error ?? null,
			});
			if (result.errorCode === "403") {
				blockedResult = result;
				break;
			}
		}
	}
	return blockedResult;
}

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
 * Renders the Telegram-native digest (parse-mode entities) and sends a silent
 * message via the Telegram sender. When prediction-market cards rasterize to
 * PNGs, Unicode bars are omitted from the text and each card follows as a
 * silent `sendPhoto`. Grok news/rumors are intentionally omitted from `extras`
 * by the caller. Claims the `telegram` channel of the daily slot so it retries
 * and advances independently of email.
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

	// Channel usability is re-checked here (chat linked + not opted out) so a
	// concurrent opt-out between content prep and delivery is honored.
	if (!isTelegramChannelUsable(user) || user.telegram_chat_id == null) {
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
	const digest = extras.predictionMarketsDigest;
	const pmCards = digest ? [...digest.assetCards, ...digest.macroCards] : [];
	const pmPhotos =
		pmCards.length > 0
			? await renderPredictionMarketPhotos({
					cards: pmCards,
					timeZone,
					use24Hour,
					logger,
					userId: user.id,
				})
			: [];

	const formatted = formatDailyDigestTelegram({
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		dateLabel,
		delayBanner,
		marketClosureInfo,
		is24Hour: use24Hour,
		timeZone,
		telegramOmitBarKeys: new Set(pmPhotos.map((p) => p.card.key)),
		sparklines,
		marketOpen,
	});

	const result = await telegramSenderResult.sender({
		chatId: user.telegram_chat_id,
		text: formatted.text,
		entities: formatted.entities,
		replyMarkup: buildDashboardButton("dailyNotifications"),
		// Routine scheduled digest — deliver silently like other passive updates.
		disableNotification: true,
	});

	let photoBlocked: DeliveryResult | null = null;
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
	} else if (pmPhotos.length > 0) {
		// Photos are best-effort follow-ups; digest completion still tracks the text send.
		photoBlocked = await sendPredictionMarketPhotos({
			sender: telegramSenderResult.sender,
			chatId: user.telegram_chat_id,
			photos: pmPhotos,
			logger,
			userId: user.id,
			scheduledDate,
			scheduledMinutes,
		});
	}

	await optOutIfBotBlocked(supabase, user.id, photoBlocked ?? result, logger);

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
		logMessage: formatted.text,
		budgetReserved: true,
	});
}
