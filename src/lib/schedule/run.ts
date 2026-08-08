/*
 * Per-minute notification scheduler (live deliver only).
 *
 * Each EventBridge tick:
 *   1. Capture quotes / price-history / flat price alerts (once)
 *   2. Deliver due market-scheduled + daily-digest users via the full live pipeline
 *
 * Daily digests build and send at due time (prices, PM PNGs, email Grok). Failures
 * retry via scheduled_notifications backoff — there is no look-ahead staging.
 */

import { DateTime } from "luxon";
import { DAILY_DISPATCH_BATCH_SIZE } from "../constants";
import { dispatchDailyDigestUser } from "../daily-digest/dispatch";
import { fetchDailyNotificationUsers } from "../daily-notification/query";
import type { SupabaseAdminClient } from "../db/supabase";
import { batchLoadUserAssets, type UserAssetsMap } from "../db/user-assets";
import type { Logger } from "../logging";
import {
	getPriceCacheSymbols,
	purgeOldPriceHistoryCache,
	storePriceHistoryMinuteSnapshots,
} from "../market-data/price-history-cache";
import { fetchAssetPricesWithSessionState, fetchExtendedQuotes } from "../market-data/prices";
import {
	type FlatPriceAlertTotals,
	processFlatPriceAlerts,
} from "../market-notifications/flat-alerts/process";
import { processMarketScheduledUser } from "../market-notifications/scheduled/process";
import { fetchMarketScheduledUsers } from "../market-notifications/scheduled/query";
import type { LogoCache } from "../messaging/logo-fetcher";
import type { NotificationSenders } from "../messaging/senders";
import { createNotificationSenders } from "../messaging/senders";
import { purgeOldPredictionMarketOdds } from "../prediction-markets/store";
import { USER_PROCESS_BATCH_SIZE } from "../scheduled-notifications/constants";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { toIsoOrThrow } from "../time/display";
import { getUsMarketClosureInfoForInstant } from "../time/market/calendar";
import type { MarketClosureInfo } from "../time/types";
import type { AssetPriceMap, ExtendedQuoteMap, MarketSession } from "../types";
import { enqueuePriceHistoryStoreRetry } from "../vendors/backfill/enqueue";
import { resolveMarketSessionWithFallback } from "./market-session";

const EMPTY_TOTALS: ScheduledNotificationTotals = {
	skipped: 0,
	logFailures: 0,
	emailsSent: 0,
	emailsFailed: 0,
	telegramSent: 0,
	telegramFailed: 0,
};

/** Combine two scheduled notification totals into one aggregate. */
function mergeTotals(
	a: ScheduledNotificationTotals,
	b: ScheduledNotificationTotals,
): ScheduledNotificationTotals {
	return {
		skipped: a.skipped + b.skipped,
		logFailures: a.logFailures + b.logFailures,
		emailsSent: a.emailsSent + b.emailsSent,
		emailsFailed: a.emailsFailed + b.emailsFailed,
		telegramSent: a.telegramSent + b.telegramSent,
		telegramFailed: a.telegramFailed + b.telegramFailed,
	};
}

/** Per-invocation cache of successful live quotes reused across market users. */
type SchedulerQuoteCache = {
	prices: AssetPriceMap;
	noSessionTrade: Set<string>;
};

function createSchedulerQuoteCache(seedQuoteMap?: ExtendedQuoteMap): SchedulerQuoteCache {
	const cache: SchedulerQuoteCache = {
		prices: new Map(),
		noSessionTrade: new Set(),
	};
	if (!seedQuoteMap) {
		return cache;
	}
	for (const [symbol, quote] of seedQuoteMap) {
		if (quote !== null) {
			cache.prices.set(symbol, quote);
		}
	}
	return cache;
}

/** Merge only meaningful quote results — vendor-failure nulls stay out of the cache. */
function mergeSuccessfulQuotesIntoCache(
	cache: SchedulerQuoteCache,
	fetched: Awaited<ReturnType<typeof fetchAssetPricesWithSessionState>>,
): void {
	for (const [symbol, price] of fetched.prices) {
		if (price !== null) {
			cache.prices.set(symbol, price);
		}
	}
	for (const symbol of fetched.noSessionTrade) {
		cache.noSessionTrade.add(symbol);
	}
}

/** Deliver due market-scheduled + daily-digest users via the live pipeline. */
async function deliverDueNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: NotificationSenders["sendEmail"];
	getTelegramSender: NotificationSenders["getTelegramSender"];
	marketSession: MarketSession;
	schedulerQuoteCache: SchedulerQuoteCache;
	/** Per-invocation logo cache shared across all users (resolve each symbol's
	 *  logo at most once per cron tick, not once per user). */
	logoCache: LogoCache;
}): Promise<ScheduledNotificationTotals> {
	const {
		supabase,
		logger,
		sendEmail,
		getTelegramSender,
		marketSession,
		schedulerQuoteCache,
		logoCache,
	} = options;

	// Users set times at minute granularity so next_send_at is always at :00 seconds.
	const currentTime = DateTime.utc();
	const currentTimeIso = toIsoOrThrow(currentTime, "Failed to format UTC ISO string");

	const [marketUsers, dailyUsers] = await Promise.all([
		fetchMarketScheduledUsers({
			supabase,
			logger,
			forceSend: false,
			currentTimeIso,
		}),
		fetchDailyNotificationUsers({
			supabase,
			logger,
			forceSend: false,
			currentTimeIso,
		}),
	]);

	// Batch-load user assets for market users first (single query).
	// Derive unique symbols from the map for price fetching to avoid a redundant DB round-trip.
	const userAssetsUserIds = [...marketUsers.map((u) => u.id)];
	let userAssetsMap: UserAssetsMap = new Map();
	if (userAssetsUserIds.length > 0) {
		try {
			userAssetsMap = await batchLoadUserAssets(supabase, userAssetsUserIds, {
				includeLogoData: true,
			});
		} catch (error) {
			logger.error(
				"Failed to batch-load user assets (aborting deliver pass)",
				{
					action: "batch_load_user_assets",
					userCount: userAssetsUserIds.length,
				},
				error,
			);
			throw error;
		}
	}

	// Collect unique asset symbols across scheduled users and fetch prices in batch
	const priceMap: AssetPriceMap = new Map();
	// Symbols recognized by the vendor but with no live trade in the current session
	// (typical for illiquid pre/after-hours tickers). The scheduled-notification
	// renderer uses this to show "no pre-market trades" / "no after-hours trades"
	// instead of the generic "price unavailable".
	const marketNoSessionTrade: Set<string> = new Set();
	const marketOpen = marketSession === "regular";

	if (marketUsers.length > 0) {
		const marketUserSymbols = [
			...new Set(
				marketUsers.flatMap((u) => {
					const assets = userAssetsMap.get(u.id);
					return assets ? assets.map((a) => a.symbol) : [];
				}),
			),
		];

		if (marketUserSymbols.length > 0) {
			const missingSymbols: string[] = [];
			for (const symbol of marketUserSymbols) {
				if (schedulerQuoteCache.noSessionTrade.has(symbol)) {
					priceMap.set(symbol, null);
					marketNoSessionTrade.add(symbol);
					continue;
				}
				const cached = schedulerQuoteCache.prices.get(symbol);
				if (cached !== undefined) {
					priceMap.set(symbol, cached);
					continue;
				}
				missingSymbols.push(symbol);
			}
			if (missingSymbols.length > 0) {
				const extra = await fetchAssetPricesWithSessionState(missingSymbols, marketSession);
				for (const [symbol, price] of extra.prices) {
					priceMap.set(symbol, price);
				}
				for (const symbol of extra.noSessionTrade) {
					marketNoSessionTrade.add(symbol);
				}
				mergeSuccessfulQuotesIntoCache(schedulerQuoteCache, extra);
			}
		}
	}

	// Fetch market closure once for market-scheduled banners. Daily digests classify
	// closure from each user's dueAt inside processDailyDigestUser.
	const needsClosureInfo = !marketOpen && marketUsers.length > 0;
	let marketClosureInfo: MarketClosureInfo | null = null;
	if (needsClosureInfo) {
		try {
			marketClosureInfo = await getUsMarketClosureInfoForInstant(currentTime);
		} catch (error) {
			logger.error(
				"Market closure lookup failed (continuing without closure info)",
				{ action: "market_closure_prefetch" },
				error,
			);
		}
	}

	const results: ScheduledNotificationTotals[] = [];

	for (let index = 0; index < marketUsers.length; index += USER_PROCESS_BATCH_SIZE) {
		const batch = marketUsers.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processMarketScheduledUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getTelegramSender,
					priceMap,
					noSessionTrade: marketNoSessionTrade,
					marketSession,
					userAssetsMap,
					marketClosureInfo,
					logoCache,
				}),
			),
		);
		results.push(...batchResults);
	}

	if (dailyUsers.length > 0) {
		for (let index = 0; index < dailyUsers.length; index += DAILY_DISPATCH_BATCH_SIZE) {
			const batch = dailyUsers.slice(index, index + DAILY_DISPATCH_BATCH_SIZE);
			const dispatchResults = await Promise.allSettled(
				batch.map((user) =>
					dispatchDailyDigestUser({
						userId: user.id,
						user,
						currentTimeIso,
						marketOpen,
						supabase,
						sendEmail,
						getTelegramSender,
						logoCache,
					}),
				),
			);

			for (const result of dispatchResults) {
				if (result.status === "fulfilled") {
					results.push(result.value);
				} else {
					logger.error(
						"Fan-out dispatch rejected",
						{ action: "dispatch_daily_user" },
						result.reason,
					);
					results.push({
						skipped: 1,
						logFailures: 0,
						emailsSent: 0,
						emailsFailed: 0,
						telegramSent: 0,
						telegramFailed: 0,
					});
				}
			}
		}
	}

	return results.reduce((acc, curr) => mergeTotals(acc, curr), { ...EMPTY_TOTALS });
}

/**
 * Run the scheduled notification cron (single live-deliver pass).
 */
export async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<
	ScheduledNotificationTotals & {
		flatPriceAlerts?: FlatPriceAlertTotals;
	}
> {
	const { supabase, logger } = options;

	// Resolve market session once per scheduler invocation — passed to price alerts
	// and live delivery to avoid redundant Massive status calls.
	// Degrades to the last-known-good session (or "closed") on a Massive blip so a
	// transient vendor failure can't abort the entire per-minute run.
	const { session: schedulerMarketSession, degraded: marketSessionDegraded } =
		await resolveMarketSessionWithFallback();
	if (marketSessionDegraded) {
		logger.warn("Market session resolution degraded (using cached/closed fallback)", {
			action: "market_session",
			session: schedulerMarketSession,
		});
	}

	// Fetch the watched-symbol quote universe for the price-history capture below. The
	// resulting map is a superset of the price-move-alert symbols, so it both seeds the
	// scheduler quote cache and feeds the flat price-alert check — no extra Massive call
	// for those. Stays `undefined` when the capture throws, so the flat-alert step below
	// can tell "fetch failed" apart from "no quotes".
	let capturedQuoteMap: ExtendedQuoteMap | undefined;
	if (schedulerMarketSession !== "closed") {
		try {
			const cacheSymbols = await getPriceCacheSymbols(supabase);
			capturedQuoteMap =
				cacheSymbols.length > 0
					? await fetchExtendedQuotes(cacheSymbols, schedulerMarketSession)
					: new Map();
			if (capturedQuoteMap.size > 0) {
				const failedRows = await storePriceHistoryMinuteSnapshots(supabase, capturedQuoteMap);
				if (failedRows) {
					const enqueued = await enqueuePriceHistoryStoreRetry({
						rows: failedRows,
						reason: "minute_snapshot_store_failed",
					});
					if (!enqueued) {
						logger.error(
							"Failed to enqueue price-history-store retry",
							{ action: "price_history_capture", rowCount: failedRows.length },
							new Error("SQS enqueue failed"),
						);
					}
				}
			}
		} catch (error) {
			logger.warn(
				"Price history minute capture failed (non-fatal)",
				{ action: "price_history_capture" },
				error,
			);
		}
	}

	try {
		const purgedCache = await purgeOldPriceHistoryCache(supabase);
		if (purgedCache.minutePurged > 0 || purgedCache.dailyPurged > 0) {
			logger.info("Purged old price history cache rows", {
				action: "purge_price_history_cache",
				minutePurged: purgedCache.minutePurged,
				dailyPurged: purgedCache.dailyPurged,
			});
		}
	} catch (error) {
		logger.warn(
			"Failed to purge old price history cache (non-fatal)",
			{ action: "purge_price_history_cache" },
			error,
		);
	}

	try {
		const purgedOdds = await purgeOldPredictionMarketOdds(supabase, logger);
		if (purgedOdds > 0) {
			logger.info("Purged old prediction-market odds rows", {
				action: "purge_prediction_market_odds",
				purged: purgedOdds,
			});
		}
	} catch (error) {
		logger.warn(
			"Failed to purge old prediction-market odds (non-fatal)",
			{ action: "purge_prediction_market_odds" },
			error,
		);
	}

	// Run flat price alerts — own state, own users, own emails. Reuses the captured
	// quote map (a superset of the watched-symbol universe) and derives market-hours
	// gating from the resolved session, so there is no extra live-quote fetch.
	// An `undefined` map means the quote capture FAILED (not "no quotes") — skip the
	// pass and log it explicitly so a blind alerting tick is observable, not silent.
	// Error when equity session is open (pre/RTH/AH): stock-buyer lambda wakes need
	// quotes too; RTH also covers human email/telegram flat alerts.
	let flatPriceAlertTotals: FlatPriceAlertTotals | undefined;
	const equitySessionOpen =
		schedulerMarketSession === "pre" ||
		schedulerMarketSession === "regular" ||
		schedulerMarketSession === "after";
	if (capturedQuoteMap !== undefined) {
		try {
			flatPriceAlertTotals = await processFlatPriceAlerts({
				supabase,
				quoteMap: capturedQuoteMap,
				marketSession: schedulerMarketSession,
			});

			logger.info("Flat price alerts processed", {
				action: "flat_price_alerts",
				session: schedulerMarketSession,
				...flatPriceAlertTotals,
			});
		} catch (error) {
			logger.warn(
				"Flat price alerts processing failed (non-fatal)",
				{ action: "flat_price_alerts", session: schedulerMarketSession },
				error,
			);
		}
	} else if (equitySessionOpen) {
		logger.error(
			"Flat price alerts skipped: quote capture unavailable during equity session",
			{ action: "flat_price_alerts", session: schedulerMarketSession },
			new Error("Quote capture failed; price-move alerting is blind this tick"),
		);
	}

	const { sendEmail, getTelegramSender, logoCache } = createNotificationSenders();
	// Seed from the captured (superset) map so live delivery reuses the watched-symbol
	// quotes the price-history capture already fetched, instead of re-fetching them.
	const schedulerQuoteCache = createSchedulerQuoteCache(capturedQuoteMap);

	const totals = await deliverDueNotifications({
		supabase,
		logger,
		sendEmail,
		getTelegramSender,
		marketSession: schedulerMarketSession,
		schedulerQuoteCache,
		logoCache,
	});

	return {
		...totals,
		flatPriceAlerts: flatPriceAlertTotals,
	};
}
