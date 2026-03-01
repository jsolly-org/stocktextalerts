import { DateTime } from "luxon";
import { buildAssetEventsContent } from "../asset-events/content";
import { updateUserAssetEventsNextSendAt } from "../asset-events/next-send-at";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { shouldSendSms } from "../messaging/sms";
import type { SmsExtras } from "../messaging/sms/delivery";
import type { SparklineMap } from "../messaging/sparkline";
import type { UserRecord } from "../messaging/types";
import {
	buildNewsContextForGrok,
	fetchFinnhubExtras,
} from "../providers/finnhub";
import type { GrokSectionResult } from "../providers/grok";
import {
	generateNewsWithGrok,
	generateRumorsWithGrok,
} from "../providers/grok";
import { fetchSnapshotQuotes } from "../providers/massive";
import {
	type AssetPriceMap,
	fetchAssetPrices,
	fetchSparklines,
} from "../providers/price-fetcher";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../schedule/helpers";
import { loadUserAssets } from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import { upsertStagedNotification } from "../staged-notifications/db";
import type { StagedDailyData } from "../staged-notifications/types";
import {
	getUsMarketClosureInfoForInstant,
	type MarketClosureInfo,
} from "../time/market-calendar";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsMessage,
	processDailyDigestEmailDelivery,
	processDailyDigestSmsDelivery,
} from "./delivery";
import { updateUserDailyDigestNextSendAt } from "./next-send-at";

const GROK_WINDOW_HOURS = 24;
const GROK_MAX_SENDS_PER_WINDOW = 10;

/** Return whether Grok is allowed within the user's rolling window limit. */
function canInvokeGrokWithinLimit(options: {
	grokWindowStart: string | null;
	grokSendsInWindow: number;
	currentTimeUtc: DateTime;
}): boolean {
	const { grokWindowStart, grokSendsInWindow, currentTimeUtc } = options;
	if (!grokWindowStart) {
		return true;
	}
	const windowStart = DateTime.fromISO(grokWindowStart, { zone: "utc" });
	if (!windowStart.isValid) {
		return true;
	}
	// If the window has expired, the counter will be reset — allow the send.
	if (currentTimeUtc.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS) {
		return true;
	}
	// Within the window — check the counter.
	return grokSendsInWindow < GROK_MAX_SENDS_PER_WINDOW;
}

interface DailyScheduleContext {
	scheduledDate: string;
	scheduledMinutes: number;
}

/** Derive the (scheduledDate, scheduledMinutes) key for daily digest delivery. */
function parseDailyScheduleContext(
	user: UserRecord,
	currentTime: DateTime,
	logger: Logger,
): DailyScheduleContext | null {
	const dueAt = user.daily_digest_next_send_at
		? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
		: currentTime;
	if (!dueAt.isValid) {
		logger.error("Invalid daily_digest_next_send_at timestamp", {
			userId: user.id,
			daily_digest_next_send_at: user.daily_digest_next_send_at,
		});
		return null;
	}
	const dueAtLocal = dueAt.setZone(user.timezone);
	if (!dueAtLocal.isValid) {
		logger.error("Failed to format local date for timezone (daily)", {
			userId: user.id,
			timezone: user.timezone,
		});
		return null;
	}
	const scheduledDate = dueAtLocal.toISODate();
	if (!scheduledDate) {
		logger.error("Failed to format scheduled date (daily)", {
			userId: user.id,
			timezone: user.timezone,
			daily_digest_next_send_at: user.daily_digest_next_send_at,
		});
		return null;
	}
	const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
	if (scheduledMinutes === null) {
		logger.error("Failed to calculate scheduled minutes (daily)", {
			action: "daily_run",
			userId: user.id,
			timezone: user.timezone,
			daily_digest_next_send_at: user.daily_digest_next_send_at,
			scheduledDate,
		});
		return null;
	}
	return { scheduledDate, scheduledMinutes };
}

/** Resolve whether Grok can be used and whether the run should be skipped. */
function resolveGrokEligibility(
	user: UserRecord,
	needsGrok: boolean,
	currentTimeUtc: DateTime,
	logger: Logger,
	scheduledDate: string,
	scheduledMinutes: number,
): { grokAllowed: boolean; skip: boolean } {
	const grokAllowed =
		needsGrok &&
		canInvokeGrokWithinLimit({
			grokWindowStart: user.grok_window_start,
			grokSendsInWindow: user.grok_sends_in_window,
			currentTimeUtc,
		});

	if (needsGrok && !grokAllowed) {
		// Grok limit reached, but asset events bundled into daily can still proceed
		const hasAnyAssetEventsOption =
			user.asset_events_include_calendar_email ||
			user.asset_events_include_calendar_sms ||
			user.asset_events_include_ipo_email ||
			user.asset_events_include_ipo_sms ||
			user.asset_events_include_analyst_email ||
			user.asset_events_include_analyst_sms ||
			user.asset_events_include_insider_email ||
			user.asset_events_include_insider_sms;
		if (!hasAnyAssetEventsOption) {
			logger.info(
				"Skipping daily digest: Grok send limit reached for this window",
				{
					action: "daily_run",
					reason: "grok_limit",
					userId: user.id,
					scheduledDate,
					scheduledMinutes,
					grokSendsInWindow: user.grok_sends_in_window,
				},
			);
			return { grokAllowed, skip: true };
		}
	}

	return { grokAllowed, skip: false };
}

/** Persist Grok usage counters after at least one successful delivery. */
async function updateGrokSendCounter(
	user: UserRecord,
	supabase: SupabaseAdminClient,
	grokAllowed: boolean,
	stats: ScheduledNotificationTotals,
	currentTime: DateTime,
	logger: Logger,
): Promise<void> {
	if (!grokAllowed || (stats.emailsSent === 0 && stats.smsSent === 0)) return;

	const now = currentTime.toISO();
	if (!now) return;

	// If the window has expired (or never started), reset the counter.
	const windowStart = user.grok_window_start
		? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
		: null;
	const windowExpired =
		!windowStart?.isValid ||
		currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

	const newCount = windowExpired ? 1 : user.grok_sends_in_window + 1;
	const newWindowStart = windowExpired ? now : user.grok_window_start;

	user.grok_sends_in_window = newCount;
	user.grok_window_start = newWindowStart;
	user.last_grok_rumors_at = now;

	const { error } = await supabase
		.from("users")
		.update({
			last_grok_rumors_at: now,
			grok_window_start: newWindowStart,
			grok_sends_in_window: newCount,
		})
		.eq("id", user.id);
	if (error) {
		logger.error(
			"Failed to update grok send counter (daily)",
			{ userId: user.id, newCount, newWindowStart },
			error,
		);
	}
}

/** Process one user's daily digest notification (deliver now or stage for later). */
export async function processDailyDigestUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	/** When true, stage content for later delivery instead of sending now. */
	stageOnly?: boolean;
	/** Pre-fetched market closure info (avoids per-user API calls in fan-out). */
	marketClosureInfo?: MarketClosureInfo | null;
}): Promise<ScheduledNotificationTotals> {
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};
	const {
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		stageOnly,
		marketClosureInfo: marketClosureInfoParam,
	} = options;

	try {
		const scheduleCtx = parseDailyScheduleContext(user, currentTime, logger);
		if (!scheduleCtx) {
			stats.skipped++;
			return stats;
		}
		const { scheduledDate, scheduledMinutes } = scheduleCtx;

		const hasAnyDailyOption =
			user.daily_digest_include_news_email ||
			user.daily_digest_include_rumors_email;

		const hasAnyAssetEventsOption =
			user.asset_events_include_calendar_email ||
			user.asset_events_include_calendar_sms ||
			user.asset_events_include_ipo_email ||
			user.asset_events_include_ipo_sms ||
			user.asset_events_include_analyst_email ||
			user.asset_events_include_analyst_sms ||
			user.asset_events_include_insider_email ||
			user.asset_events_include_insider_sms;

		if (!hasAnyDailyOption && !hasAnyAssetEventsOption) {
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			}
			return stats;
		}

		const userAssets = await loadUserAssets(supabase, user.id);
		const tickers = userAssets.map((s) => s.symbol);

		const needsGrok =
			user.daily_digest_include_news_email ||
			user.daily_digest_include_rumors_email;
		const { grokAllowed, skip: grokSkip } = resolveGrokEligibility(
			user,
			needsGrok,
			currentTime,
			logger,
			scheduledDate,
			scheduledMinutes,
		);
		if (grokSkip) {
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			}
			return stats;
		}

		const emailEnabled = user.email_notifications_enabled;
		const smsEnabled = shouldSendSms(user);

		if (!emailEnabled && !smsEnabled) {
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			}
			return stats;
		}

		let assetPrices: AssetPriceMap = new Map();
		if ((emailEnabled || smsEnabled) && tickers.length > 0) {
			try {
				assetPrices = await fetchAssetPrices(tickers);
			} catch (error) {
				logger.warn("Failed to fetch daily digest prices", {
					action: "daily_run",
					userId: user.id,
					tickerCount: tickers.length,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		let sparklines: SparklineMap = new Map();
		if (user.show_sparklines && tickers.length > 0) {
			try {
				sparklines = await fetchSparklines(tickers);
			} catch (error) {
				logger.warn("Failed to fetch sparklines for daily digest", {
					action: "daily_run",
					userId: user.id,
					tickerCount: tickers.length,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (tickers.length > 0 && (emailEnabled || smsEnabled)) {
			const missingTickers = tickers.filter(
				(ticker) => assetPrices.get(ticker) === null,
			);
			if (missingTickers.length === tickers.length) {
				logger.error("No price data available for daily digest tickers", {
					action: "daily_run",
					userId: user.id,
					tickerCount: tickers.length,
					tickers: missingTickers,
				});
			} else if (missingTickers.length > 0) {
				logger.warn("Partial price data missing for daily digest tickers", {
					action: "daily_run",
					userId: user.id,
					missingCount: missingTickers.length,
					missingTickers,
				});
			}

			if (missingTickers.length > 0) {
				try {
					const retrySnapshot = await fetchSnapshotQuotes(missingTickers);
					const recoveredTickers: string[] = [];
					const stillMissingTickers: string[] = [];
					for (const ticker of missingTickers) {
						const snap = retrySnapshot.get(ticker);
						if (snap) {
							assetPrices.set(ticker, {
								price: snap.price,
								changePercent: snap.changePercent,
							});
							recoveredTickers.push(ticker);
						} else {
							stillMissingTickers.push(ticker);
						}
					}

					if (recoveredTickers.length > 0) {
						logger.info("Recovered daily digest prices via snapshot retry", {
							action: "daily_run",
							userId: user.id,
							recoveredCount: recoveredTickers.length,
							recoveredTickers,
						});
					}
					if (stillMissingTickers.length > 0) {
						logger.warn("Snapshot retry missing daily digest prices", {
							action: "daily_run",
							userId: user.id,
							missingCount: stillMissingTickers.length,
							missingTickers: stillMissingTickers,
						});
					}
				} catch (error) {
					logger.warn("Failed snapshot retry for daily digest prices", {
						action: "daily_run",
						userId: user.id,
						missingCount: missingTickers.length,
						missingTickers,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		// Check whether the US market is closed today (weekend / holiday).
		// Use the user's scheduled send instant (not job execution time) so digests
		// near US midnight classify the correct market day during precompute.
		const closureRefInstant = user.daily_digest_next_send_at
			? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
			: currentTime;
		const marketClosureInfo =
			marketClosureInfoParam !== undefined
				? marketClosureInfoParam
				: await getUsMarketClosureInfoForInstant(closureRefInstant);

		/* =============
		Fetch Finnhub data (non-blocking — failures omit that section)
		============= */
		const finnhubData = await fetchFinnhubExtras(tickers, {
			includeNews: user.daily_digest_include_news_email,
			includeAnalyst: false,
			includeInsider: false,
		});

		// Build news context for Grok from Finnhub headlines
		const newsContext = user.daily_digest_include_news_email
			? buildNewsContextForGrok(finnhubData.news)
			: undefined;

		// Grok news/rumors are email-only (SMS body can exceed Twilio's 1600-char limit)
		let newsResult: GrokSectionResult | null = null;
		let rumorsResult: GrokSectionResult | null = null;

		if (grokAllowed && emailEnabled) {
			[newsResult, rumorsResult] = await Promise.all([
				user.daily_digest_include_news_email
					? generateNewsWithGrok({
							tickers,
							localDateIso: scheduledDate,
							timezone: user.timezone,
							finnhubNewsContext: newsContext || undefined,
						})
					: Promise.resolve(null),
				user.daily_digest_include_rumors_email
					? generateRumorsWithGrok({
							tickers,
							localDateIso: scheduledDate,
							timezone: user.timezone,
						})
					: Promise.resolve(null),
			]);
		}

		const mergedCitations = [
			...new Set([
				...(newsResult?.citations ?? []),
				...(rumorsResult?.citations ?? []),
			]),
		];
		if (mergedCitations.length > 0) {
			logger.info("Grok citations returned", {
				action: "daily_run",
				userId: user.id,
				citationCount: mergedCitations.length,
				citations: mergedCitations,
			});
		}

		/* =============
		Build asset events content (bundled into daily digest)
		============= */
		const dueAtLocal = (
			user.daily_digest_next_send_at
				? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
				: currentTime
		).setZone(user.timezone);
		const localDate = dueAtLocal.toISODate() ?? "";

		let emailAssetEvents: Awaited<
			ReturnType<typeof buildAssetEventsContent>
		> | null = null;
		let smsAssetEvents: Awaited<
			ReturnType<typeof buildAssetEventsContent>
		> | null = null;

		if (hasAnyAssetEventsOption) {
			const wantsAssetEventsEmail =
				emailEnabled &&
				(user.asset_events_include_calendar_email ||
					user.asset_events_include_ipo_email ||
					user.asset_events_include_analyst_email ||
					user.asset_events_include_insider_email);
			const wantsAssetEventsSms =
				smsEnabled &&
				(user.asset_events_include_calendar_sms ||
					user.asset_events_include_ipo_sms ||
					user.asset_events_include_analyst_sms ||
					user.asset_events_include_insider_sms);
			if (wantsAssetEventsEmail) {
				emailAssetEvents = await buildAssetEventsContent({
					user,
					supabase,
					logger,
					localDate,
					tickers,
					channel: "email",
				});
			}
			if (wantsAssetEventsSms) {
				smsAssetEvents = await buildAssetEventsContent({
					user,
					supabase,
					logger,
					localDate,
					tickers,
					channel: "sms",
				});
			}
		}

		/* =============
		Build extras per channel
		============= */
		const buildExtras = (channel: "email" | "sms"): SmsExtras => {
			const isSms = channel === "sms";
			return {
				news: isSms ? null : (newsResult?.content ?? null),
				rumors: isSms ? null : (rumorsResult?.content ?? null),
				analyst: null,
				insider: null,
				citations:
					!isSms && mergedCitations.length > 0 ? mergedCitations : undefined,
			};
		};

		const emailExtras = emailEnabled ? buildExtras("email") : null;
		const smsExtras = smsEnabled ? buildExtras("sms") : null;

		const hasEmailContent = !!(
			(userAssets.length > 0 && emailEnabled) ||
			emailExtras?.news ||
			emailExtras?.rumors ||
			emailAssetEvents?.hasAnyContent
		);
		const hasSmsContent = !!(
			(userAssets.length > 0 && smsEnabled) ||
			smsExtras?.news ||
			smsExtras?.rumors ||
			smsAssetEvents?.hasAnyContent
		);

		if (!hasEmailContent && !hasSmsContent) {
			logger.info("Skipping daily digest: no content available", {
				action: "daily_run",
				reason: "no_content",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
				if (hasAnyAssetEventsOption) {
					await updateUserAssetEventsNextSendAt({
						user,
						supabase,
						logger,
						currentTime,
					});
				}
			}
			return stats;
		}

		/* ============= Stage-only: write to staging table and return ============= */
		// Pre-compute path: render the full digest (prices, Grok, asset events) now
		// and store it in staged_notifications for near-instant delivery later.
		// We do NOT advance next_send_at, update Grok counters, or update the
		// analyst month here — the delivery phase (staged-notifications/deliver.ts)
		// handles all post-delivery side-effects using metadata captured below
		// (grokAllowed, hasAnyAssetEventsOption, shouldUpdateAnalyst, analystMonth).
		if (stageOnly) {
			const scheduledForIso =
				user.daily_digest_next_send_at ?? currentTime.toISO();
			if (!scheduledForIso) {
				logger.error("Cannot determine scheduled_for for daily staging", {
					userId: user.id,
				});
				stats.skipped++;
				return stats;
			}

			const emailContent =
				hasEmailContent && emailExtras
					? formatDailyDigestEmail({
							user,
							userAssets,
							assetPrices,
							formatPrefs: { show_sparklines: user.show_sparklines },
							extras: emailExtras,
							assetEvents: emailAssetEvents,
							sparklines,
							marketClosureInfo,
						})
					: null;

			const smsContent =
				hasSmsContent && smsExtras
					? {
							message: await formatDailyDigestSmsMessage({
								userAssets,
								assetPrices,
								formatPrefs: { show_sparklines: user.show_sparklines },
								extras: smsExtras,
								assetEvents: smsAssetEvents,
								sparklines,
								supabase,
							}),
						}
					: null;

			const shouldUpdateAnalyst = !!(
				emailAssetEvents?.shouldUpdateAnalystMonth ||
				smsAssetEvents?.shouldUpdateAnalystMonth
			);

			const stagedData: StagedDailyData = {
				type: "daily",
				scheduledDate,
				scheduledMinutes,
				email: emailContent,
				sms: smsContent,
				grokAllowed,
				hasAnyAssetEventsOption,
				shouldUpdateAnalyst,
				analystMonth: shouldUpdateAnalyst
					? dueAtLocal.toFormat("yyyy-MM")
					: null,
			};

			const { error: stageError } = await upsertStagedNotification(supabase, {
				userId: user.id,
				notificationType: "daily",
				scheduledFor: scheduledForIso,
				stagedData,
			});

			if (stageError) {
				logger.error(
					"Failed to stage daily digest notification",
					{ userId: user.id },
					stageError,
				);
				stats.skipped++;
			}

			return stats;
		}

		if (hasEmailContent && emailExtras) {
			await processDailyDigestEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetPrices,
				formatPrefs: {
					show_sparklines: user.show_sparklines,
				},
				extras: emailExtras,
				assetEvents: emailAssetEvents,
				sparklines,
				marketClosureInfo,
				sendEmail,
				stats,
			});
		}

		if (hasSmsContent && smsExtras) {
			await processDailyDigestSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetPrices,
				extras: smsExtras,
				assetEvents: smsAssetEvents,
				sparklines,
				getSmsSender,
				stats,
			});
		}

		await updateGrokSendCounter(
			user,
			supabase,
			grokAllowed,
			stats,
			currentTime,
			logger,
		);

		/* =============
		Advance next-send-at for daily + asset events
		============= */
		await updateUserDailyDigestNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		if (hasAnyAssetEventsOption) {
			await updateUserAssetEventsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		}

		// Update analyst sent month if analyst content was included
		const shouldUpdateAnalyst =
			emailAssetEvents?.shouldUpdateAnalystMonth ||
			smsAssetEvents?.shouldUpdateAnalystMonth;
		if (shouldUpdateAnalyst) {
			const currentMonth = dueAtLocal.toFormat("yyyy-MM");
			const { error: analystError } = await supabase
				.from("users")
				.update({ asset_events_last_analyst_sent_month: currentMonth })
				.eq("id", user.id);
			if (analystError) {
				logger.error(
					"Failed to update asset_events_last_analyst_sent_month",
					{ userId: user.id },
					analystError,
				);
			}
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error(
			"Error processing daily digest user",
			{ userId: user.id },
			error,
		);
		/* =============
		Best-effort reschedule to avoid retry storms on persistent failures.
		============= */
		if (!stageOnly) {
			try {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			} catch (updateError) {
				logger.error(
					"Failed to update daily_digest_next_send_at after daily digest error",
					{ userId: user.id },
					updateError,
				);
			}
		}
		return stats;
	}
}
