import { DateTime } from "luxon";
import type { Logger } from "../../logging";
import { formatAssetsTextList } from "../../messaging/asset-formatting";
import type { EmailSender } from "../../messaging/email/utils";
import { formatEmailMessage } from "../../messaging/email/utils";
import {
	createLogoCache,
	prefetchLogos,
	renderLogoImg,
} from "../../messaging/logo-fetcher";
import { recordNotification } from "../../messaging/shared";
import { shouldSendSms } from "../../messaging/sms";
import { formatSmsMessage } from "../../messaging/sms/delivery";
import type { SparklineMap } from "../../messaging/sparkline";
import type { UserRecord } from "../../messaging/types";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import { fetchSparklines } from "../../providers/price-fetcher";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	SupabaseAdminClient,
	UserAssetsMap,
} from "../../schedule/helpers";
import { loadUserAssets } from "../../schedule/helpers";
import type { SmsSenderProvider } from "../../schedule/sms-sender";
import { upsertStagedNotification } from "../../staged-notifications/db";
import type { StagedMarketData } from "../../staged-notifications/types";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { getUsMarketClosureInfoForInstant } from "../../time/market-calendar";
import { getLocalMinutesFromDateTime } from "../../time/scheduled-times";
import {
	processMarketScheduledEmailDelivery,
	processMarketScheduledSmsDelivery,
} from "./delivery";
import { updateUserMarketScheduledNextSendAt } from "./next-send-at";

/** Process a single user's scheduled market asset update notification. */
export async function processMarketScheduledUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	priceMap: AssetPriceMap;
	marketOpen: boolean;
	/** Market closure info for banner when marketOpen is false. */
	marketClosureInfo?: MarketClosureInfo | null;
	/** When true, stage content for later delivery instead of sending now. */
	stageOnly?: boolean;
	/** Pre-fetched user assets (avoids N+1 when batch processing). */
	userAssetsMap?: UserAssetsMap;
	/** Pre-shortened dashboard URL for SMS; avoids per-message shortenUrl when set. */
	dashboardUrl?: string;
}): Promise<ScheduledNotificationTotals> {
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};
	let attemptedDeliveryMethod: DeliveryMethod | null = null;
	const {
		user,
		supabase,
		logger,
		sendEmail,
		currentTime,
		getSmsSender,
		priceMap,
		marketOpen,
		marketClosureInfo,
		stageOnly,
		userAssetsMap,
		dashboardUrl,
	} = options;

	try {
		/* =============
		Cron vs manual schedule anchoring
		Normal cron only processes users with market_scheduled_asset_price_next_send_at set; manual sends (--force)
		may include users without market_scheduled_asset_price_next_send_at (e.g. newly enabled scheduled updates). In that case,
		use "now" as the schedule anchor.
		============= */
		const dueAt = user.market_scheduled_asset_price_next_send_at
			? DateTime.fromISO(user.market_scheduled_asset_price_next_send_at, {
					zone: "utc",
				})
			: currentTime;
		if (!dueAt.isValid) {
			logger.error(
				"Invalid market_scheduled_asset_price_next_send_at timestamp",
				{
					userId: user.id,
					market_scheduled_asset_price_next_send_at:
						user.market_scheduled_asset_price_next_send_at,
				},
			);
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error("Failed to format local date for timezone", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error("Failed to format scheduled date", {
				userId: user.id,
				timezone: user.timezone,
				market_scheduled_asset_price_next_send_at:
					user.market_scheduled_asset_price_next_send_at,
				dueAt: dueAt.toISO(),
				dueAtLocalIso: dueAtLocal.toISO(),
			});
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error("Failed to calculate scheduled minutes", {
				action: "market_notifications_run",
				phase: "getLocalMinutesFromDateTime",
				userId: user.id,
				timezone: user.timezone,
				market_scheduled_asset_price_next_send_at:
					user.market_scheduled_asset_price_next_send_at,
				dueAt: dueAt.toISO(),
				dueAtLocalIso: dueAtLocal.toISO(),
				scheduledDate,
			});
			stats.skipped++;
			return stats;
		}
		const marketClosure = await getUsMarketClosureInfoForInstant(dueAt);
		if (marketClosure) {
			logger.info("Skipping scheduled market delivery for closed market date", {
				userId: user.id,
				reason: marketClosure.reason,
				dueAt: dueAt.toISO(),
			});
			stats.skipped++;
			await updateUserMarketScheduledNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const userAssets =
			userAssetsMap?.get(user.id) ?? (await loadUserAssets(supabase, user.id));
		const formatPrefs = {
			show_sparklines: user.show_sparklines,
		};

		const tickers = userAssets.map((a) => a.symbol);
		let sparklines: SparklineMap = new Map();
		if (user.show_sparklines && tickers.length > 0) {
			try {
				sparklines = await fetchSparklines(tickers);
			} catch (error) {
				logger.warn(
					"Failed to fetch sparklines for scheduled market notification",
					{
						action: "market_notifications_run",
						userId: user.id,
						tickerCount: tickers.length,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		}
		const getSparkline = (symbol: string) => sparklines.get(symbol) ?? null;
		const getAsciiSparkline = (symbol: string) => sparklines.get(symbol)?.ascii;

		const shouldPrepareEmail =
			user.email_notifications_enabled &&
			user.market_scheduled_asset_price_include_email;
		const logoCache = shouldPrepareEmail ? createLogoCache() : null;
		if (logoCache) {
			try {
				await prefetchLogos(userAssets, logoCache, supabase);
			} catch (error) {
				logger.warn(
					"Failed to prefetch logos for scheduled market notification",
					{
						action: "market_notifications_run",
						userId: user.id,
						assetCount: userAssets.length,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		}
		const getLogoHtml = logoCache
			? (symbol: string): string | undefined => {
					const dataUri = logoCache.get(symbol);
					return dataUri ? renderLogoImg(dataUri) : undefined;
				}
			: undefined;

		const assetsList = formatAssetsTextList(
			userAssets,
			(symbol) => priceMap.get(symbol) ?? undefined,
			formatPrefs,
			getAsciiSparkline,
		);

		const shouldAttemptSms = shouldSendSms(user);

		/* ============= Stage-only: write to staging table and return ============= */
		// Pre-compute path: render the notification content now and store it in
		// the staged_notifications table for near-instant delivery when the user's
		// scheduled time arrives. We intentionally do NOT advance next_send_at or
		// record delivery here — the delivery phase (deliver.ts) handles both so
		// the user's schedule only advances after the message is actually sent.
		if (stageOnly) {
			const scheduledForIso =
				user.market_scheduled_asset_price_next_send_at ?? dueAt.toISO();
			if (!scheduledForIso) {
				logger.error("Cannot determine scheduled_for for staging", {
					userId: user.id,
				});
				stats.skipped++;
				return stats;
			}

			const wantsEmail =
				user.email_notifications_enabled &&
				user.market_scheduled_asset_price_include_email;
			const wantsSms =
				shouldAttemptSms && user.market_scheduled_asset_price_include_sms;

			const emailContent = wantsEmail
				? (() => {
						const msg = formatEmailMessage(
							user,
							userAssets,
							assetsList,
							priceMap,
							marketOpen,
							formatPrefs,
							getSparkline,
							marketClosureInfo,
							getLogoHtml,
						);
						return {
							subject: "Your Scheduled Price Notification",
							text: msg.text,
							html: msg.html,
						};
					})()
				: null;

			const smsContent = wantsSms
				? {
						message: await formatSmsMessage(
							assetsList,
							marketOpen,
							undefined,
							marketClosureInfo,
							supabase,
							dashboardUrl,
						),
					}
				: null;

			const stagedData: StagedMarketData = {
				type: "market",
				scheduledDate,
				scheduledMinutes,
				marketOpen,
				email: emailContent,
				sms: smsContent,
			};

			const { error: stageError } = await upsertStagedNotification(supabase, {
				userId: user.id,
				notificationType: "market",
				scheduledFor: scheduledForIso,
				stagedData,
			});

			if (stageError) {
				logger.error(
					"Failed to stage market notification",
					{ userId: user.id },
					stageError,
				);
				stats.skipped++;
			}

			return stats;
		}

		/* ============= Process Email ============= */
		if (
			user.email_notifications_enabled &&
			user.market_scheduled_asset_price_include_email
		) {
			attemptedDeliveryMethod = "email";
			await processMarketScheduledEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetsList,
				sendEmail,
				priceMap,
				marketOpen,
				marketClosureInfo,
				stats,
				formatPrefs,
				getSparkline,
				getLogoHtml,
			});
		}

		/* ============= Process SMS ============= */
		if (shouldAttemptSms && user.market_scheduled_asset_price_include_sms) {
			attemptedDeliveryMethod = "sms";
			await processMarketScheduledSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetsList,
				getSmsSender,
				marketOpen,
				marketClosureInfo,
				stats,
				dashboardUrl,
			});
		}

		await updateUserMarketScheduledNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing user", { userId: user.id }, error);

		try {
			const deliveryAttempts =
				stats.emailsSent + stats.emailsFailed + stats.smsSent + stats.smsFailed;

			// Avoid false negatives: if delivery already happened (or was at least recorded as
			// attempted), a later failure (e.g. updating market_scheduled_asset_price_next_send_at) shouldn't log as undelivered.
			if (deliveryAttempts === 0) {
				const shouldAttemptSms = shouldSendSms(user);
				const eligibleEmail =
					user.email_notifications_enabled &&
					user.market_scheduled_asset_price_include_email;
				const eligibleSms =
					shouldAttemptSms && user.market_scheduled_asset_price_include_sms;

				const deliveryMethod: DeliveryMethod =
					attemptedDeliveryMethod ??
					(eligibleEmail
						? "email"
						: eligibleSms
							? "sms"
							: user.email_notifications_enabled
								? "email"
								: "sms");
				const logged = await recordNotification(supabase, {
					user_id: user.id,
					type: "market",
					delivery_method: deliveryMethod,
					message_delivered: false,
					message: "Error processing notification",
					error: error instanceof Error ? error.message : String(error),
				});
				if (!logged) {
					stats.logFailures++;
				}
			}
		} catch (logError) {
			logger.error(
				"Failed to record notification for user",
				{ userId: user.id },
				logError,
			);
			stats.logFailures++;
		}

		return stats;
	}
}
