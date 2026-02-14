import { DateTime } from "luxon";
import { buildAssetEventsContent } from "../asset-events/content";
import { updateUserAssetEventsNextSendAt } from "../asset-events/next-send-at";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { shouldSendSms } from "../messaging/sms";
import type { SmsExtras } from "../messaging/sms/delivery";
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
import {
	type AssetPriceMap,
	fetchAssetPrices,
} from "../providers/price-fetcher";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../schedule/helpers";
import { loadUserAssets } from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import {
	processDailyDigestEmailDelivery,
	processDailyDigestSmsDelivery,
} from "./delivery";
import { updateUserDailyDigestNextSendAt } from "./next-send-at";

const GROK_WINDOW_HOURS = 24;
const GROK_MAX_SENDS_PER_WINDOW = 10;

/**
 * Check whether a user can invoke Grok within the current rolling window.
 *
 * The window is tracked per-user via `grok_window_start` and `grok_sends_in_window`.
 * Invalid/missing window state is treated as "allowed" to avoid blocking delivery due to bad data.
 */
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

/**
 * Derive a deterministic schedule key (local date + local minutes) for daily digest delivery.
 *
 * Uses `daily_digest_next_send_at` when available; falls back to `currentTime` if missing to keep the
 * runner functional for users that haven't been fully backfilled yet.
 */
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

/**
 * Decide whether Grok may be used for this run and whether the entire run should be skipped.
 *
 * If Grok is required (e.g., rumors/news) but the user is over their window limit, we may still
 * proceed when Finnhub-only sections are enabled.
 */
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
			user.asset_events_include_earnings_email ||
			user.asset_events_include_earnings_sms ||
			user.asset_events_include_dividends_email ||
			user.asset_events_include_dividends_sms ||
			user.asset_events_include_splits_email ||
			user.asset_events_include_splits_sms ||
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

/**
 * Persist Grok usage counters to the database after a successful send.
 *
 * This is only called when Grok was allowed and at least one message was delivered (email or SMS).
 * The counter is reset when the rolling window has expired.
 */
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

/**
 * Process a single user's daily digest notification.
 *
 * - Computes a deterministic schedule key (local date + local minutes) from `daily_digest_next_send_at`
 * - Fetches optional Finnhub extras (news context, insider trades)
 * - Optionally invokes Grok for channel-specific news/rumors (rate-limited per user window)
 * - Delivers via enabled channels and advances `daily_digest_next_send_at`
 */
export async function processDailyDigestUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
}): Promise<ScheduledNotificationTotals> {
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};
	const { user, supabase, logger, currentTime, sendEmail, getSmsSender } =
		options;

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
			user.asset_events_include_earnings_email ||
			user.asset_events_include_earnings_sms ||
			user.asset_events_include_dividends_email ||
			user.asset_events_include_dividends_sms ||
			user.asset_events_include_splits_email ||
			user.asset_events_include_splits_sms ||
			user.asset_events_include_analyst_email ||
			user.asset_events_include_analyst_sms ||
			user.asset_events_include_insider_email ||
			user.asset_events_include_insider_sms;

		if (!hasAnyDailyOption && !hasAnyAssetEventsOption) {
			stats.skipped++;
			await updateUserDailyDigestNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
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
			await updateUserDailyDigestNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const emailEnabled = user.email_notifications_enabled;
		const smsEnabled = shouldSendSms(user);

		if (!emailEnabled && !smsEnabled) {
			stats.skipped++;
			await updateUserDailyDigestNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
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
				(user.asset_events_include_earnings_email ||
					user.asset_events_include_dividends_email ||
					user.asset_events_include_splits_email ||
					user.asset_events_include_analyst_email ||
					user.asset_events_include_insider_email);
			const wantsAssetEventsSms =
				smsEnabled &&
				(user.asset_events_include_earnings_sms ||
					user.asset_events_include_dividends_sms ||
					user.asset_events_include_splits_sms ||
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
		function buildExtras(channel: "email" | "sms"): SmsExtras {
			const isSms = channel === "sms";
			return {
				news: isSms ? null : (newsResult?.content ?? null),
				rumors: isSms ? null : (rumorsResult?.content ?? null),
				analyst: null,
				insider: null,
				citations:
					!isSms && mergedCitations.length > 0 ? mergedCitations : undefined,
			};
		}

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
					show_change_percent: user.show_change_percent,
					show_company_name: user.show_company_name,
					detailed_format: user.detailed_format,
				},
				extras: emailExtras,
				assetEvents: emailAssetEvents,
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
		return stats;
	}
}
