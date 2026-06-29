import type { DateTime as DateTimeType } from "luxon";
import type { AssetEventsContent } from "../asset-events/content";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { AssetPriceMap } from "../market-data-types";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsMessageBodies,
	formatDailyDigestTelegram,
} from "../messaging/notifications/daily-digest";
import type { SparklineMap } from "../messaging/parts/charts/sparkline";
import type { NotificationExtras } from "../messaging/parts/extras";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import type { StagedDailyData } from "../staged-notification-types";
import { upsertStagedNotification } from "../staged-notifications/db";
import type { MarketClosureInfo } from "../time/market/calendar";
import { assertYearMonthString, type IsoDateString, type MinuteOfDay } from "../types";
import type { UserAssetRow, UserRecord } from "../user-record-types";

export interface StageDailyDigestOptions {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTimeType;
	stats: ScheduledNotificationTotals;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	dueAtLocal: DateTimeType;
	hasEmailContent: boolean;
	hasSmsContent: boolean;
	hasTelegramContent: boolean;
	emailExtras: NotificationExtras | null;
	smsExtras: NotificationExtras | null;
	telegramExtras: NotificationExtras | null;
	emailPriceAssets: UserAssetRow[];
	emailPriceMap: AssetPriceMap;
	smsPriceAssets: UserAssetRow[];
	smsPriceMap: AssetPriceMap;
	telegramPriceAssets: UserAssetRow[];
	telegramPriceMap: AssetPriceMap;
	emailAssetEvents: AssetEventsContent | null;
	smsAssetEvents: AssetEventsContent | null;
	sparklines: SparklineMap;
	marketOpen: boolean;
	marketClosureInfo: MarketClosureInfo | null;
	getLogoHtml?: (symbol: string) => string | undefined;
	telegramDateLabel: string;
	delayBannerText: string | null;
	telegramMarketBanner: string | null;
	grokAllowed: boolean;
	hasAnyAssetEventsOption: boolean;
	shouldUpdateAnalystMonth: boolean;
}

/** Write pre-rendered daily digest content to staged_notifications for later delivery. */
export async function stageDailyDigestContent(options: StageDailyDigestOptions): Promise<void> {
	const {
		user,
		supabase,
		logger,
		currentTime,
		stats,
		scheduledDate,
		scheduledMinutes,
		dueAtLocal,
		hasEmailContent,
		hasSmsContent,
		hasTelegramContent,
		emailExtras,
		smsExtras,
		telegramExtras,
		emailPriceAssets,
		emailPriceMap,
		smsPriceAssets,
		smsPriceMap,
		telegramPriceAssets,
		telegramPriceMap,
		emailAssetEvents,
		smsAssetEvents,
		sparklines,
		marketOpen,
		marketClosureInfo,
		getLogoHtml,
		telegramDateLabel,
		delayBannerText,
		telegramMarketBanner,
		grokAllowed,
		hasAnyAssetEventsOption,
		shouldUpdateAnalystMonth,
	} = options;

	const scheduledForIso = user.daily_digest_next_send_at ?? currentTime.toISO();
	if (!scheduledForIso) {
		logger.error(
			"Cannot determine scheduled_for for daily staging",
			{ userId: user.id },
			new Error("Cannot determine scheduled_for for daily staging"),
		);
		stats.skipped++;
		return;
	}

	const emailContent =
		hasEmailContent && emailExtras
			? formatDailyDigestEmail({
					user,
					is24Hour: user.use_24_hour_time,
					userAssets: emailPriceAssets,
					assetPrices: emailPriceMap,
					extras: emailExtras,
					assetEvents: emailAssetEvents,
					sparklines,
					marketOpen,
					marketClosureInfo,
					getLogoHtml,
				})
			: null;

	const smsContent =
		hasSmsContent && smsExtras
			? {
					messages: formatDailyDigestSmsMessageBodies({
						userAssets: smsPriceAssets,
						assetPrices: smsPriceMap,
						extras: smsExtras,
						assetEvents: smsAssetEvents,
						sparklines,
						marketOpen,
						marketClosureInfo,
						is24Hour: user.use_24_hour_time,
					}),
				}
			: null;

	const telegramFormatted =
		hasTelegramContent && telegramExtras
			? formatDailyDigestTelegram({
					userAssets: telegramPriceAssets,
					assetPrices: telegramPriceMap,
					extras: telegramExtras,
					dateLabel: telegramDateLabel,
					delayBanner: delayBannerText,
					marketClosedBanner: telegramMarketBanner,
					sparklines,
					marketOpen,
				})
			: null;
	const telegramContent = telegramFormatted
		? { text: telegramFormatted.text, entities: [...telegramFormatted.entities] }
		: null;

	const stagedData: StagedDailyData = {
		type: "daily",
		scheduledDate,
		scheduledMinutes,
		email: emailContent,
		sms: smsContent,
		telegram: telegramContent,
		grokAllowed,
		hasAnyAssetEventsOption,
		shouldUpdateAnalyst: shouldUpdateAnalystMonth,
		analystMonth: shouldUpdateAnalystMonth
			? assertYearMonthString(dueAtLocal.toFormat("yyyy-MM"))
			: null,
	};

	const { error: stageError } = await upsertStagedNotification(supabase, {
		userId: user.id,
		notificationType: "daily",
		scheduledFor: scheduledForIso,
		stagedData,
	});

	if (stageError) {
		logger.error("Failed to stage daily digest notification", { userId: user.id }, stageError);
		stats.skipped++;
	}
}
