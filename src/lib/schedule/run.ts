/*
 * Two-pass cron scheduler for pre-computed notification delivery.
 *
 * ARCHITECTURE OVERVIEW
 * --------------------
 * Previously, the cron fired every minute and ran the full pipeline (DB queries,
 * API calls, Grok generation, formatting) before sending each notification. This
 * added seconds of latency between the user's scheduled time and actual delivery.
 *
 * Now the cron fires every minute but runs TWO passes, 30 seconds apart:
 *
 *   Pass 1 (~:00)                         Pass 2 (~:30)
 *   ┌─────────────────────────┐           ┌─────────────────────────┐
 *   │ 1. DELIVER staged       │           │ 1. DELIVER staged       │
 *   │ 2. DELIVER fallback     │           │ 2. DELIVER fallback     │
 *   │ 3. PRE-COMPUTE          │           │ 3. PRE-COMPUTE          │
 *   └─────────────────────────┘           └─────────────────────────┘
 *
 * - DELIVER staged: Send pre-rendered content from `staged_notifications` for
 *   users whose `scheduled_for` has arrived. This is near-instant (no API calls).
 * - DELIVER fallback: Users without staged data (new users, staging failures,
 *   first deploy) get processed via the existing full pipeline. The optimization
 *   is purely additive.
 * - PRE-COMPUTE: Look ahead 30s, run the full pipeline for those users, and
 *   write the rendered content to `staged_notifications`. Next pass delivers it.
 *
 * Price staleness from pre-compute is at most ~30 seconds, which is acceptable
 * for informational scheduled notifications.
 */

import { setTimeout as realDelay } from "node:timers/promises";
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
	type PriceAlertTotals,
	processPriceAlerts,
} from "../market-notifications/anomaly-alerts/process";
import {
	type FlatPriceAlertTotals,
	processFlatPriceAlerts,
} from "../market-notifications/flat-alerts/process";
import { processMarketScheduledUser } from "../market-notifications/scheduled/process";
import { fetchMarketScheduledUsers } from "../market-notifications/scheduled/query";
import { purgeOldAssetSnapshots } from "../market-notifications/snapshot-store";
import type { LogoCache } from "../messaging/logo-fetcher";
import type { NotificationSenders } from "../messaging/senders";
import { createNotificationSenders } from "../messaging/senders";
import { type PriceTargetTotals, processPriceTargets } from "../price-targets/process";
import { USER_PROCESS_BATCH_SIZE } from "../scheduled-notifications/constants";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { deliverStagedNotifications } from "../staged-notifications/deliver";
import { precomputeDailyDigest } from "../staged-notifications/precompute";
import { toIsoOrThrow } from "../time/display";
import { getUsMarketClosureInfoForInstant } from "../time/market/calendar";
import type { MarketClosureInfo } from "../time/types";
import type { AssetPriceMap, ExtendedQuoteMap, MarketSession } from "../types";
import { enqueuePriceHistoryStoreRetry } from "../vendors/backfill/enqueue";
import { resolveMarketSessionWithFallback } from "./market-session";
import { getPassDelayMs } from "./pass-delay";

const EMPTY_TOTALS: ScheduledNotificationTotals = {
	skipped: 0,
	logFailures: 0,
	emailsSent: 0,
	emailsFailed: 0,
	smsSent: 0,
	smsFailed: 0,
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
		smsSent: a.smsSent + b.smsSent,
		smsFailed: a.smsFailed + b.smsFailed,
		telegramSent: a.telegramSent + b.telegramSent,
		telegramFailed: a.telegramFailed + b.telegramFailed,
	};
}

/** Per-invocation cache of successful Massive quotes reused across both scheduler passes. */
type SchedulerQuoteCache = {
	prices: AssetPriceMap;
	noSessionTrade: Set<string>;
};

function createSchedulerQuoteCache(priceAlertQuoteMap?: ExtendedQuoteMap): SchedulerQuoteCache {
	const cache: SchedulerQuoteCache = {
		prices: new Map(),
		noSessionTrade: new Set(),
	};
	if (!priceAlertQuoteMap) {
		return cache;
	}
	for (const [symbol, quote] of priceAlertQuoteMap) {
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

/** Run a single pass: deliver staged → fallback → pre-compute. */
async function runPass(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: NotificationSenders["sendEmail"];
	getSmsSender: NotificationSenders["getSmsSender"];
	getTelegramSender: NotificationSenders["getTelegramSender"];
	marketSession: MarketSession;
	schedulerQuoteCache: SchedulerQuoteCache;
	/** Per-invocation logo cache shared across both passes + all users (resolve each
	 *  symbol's logo at most once per cron tick, not once per user). */
	logoCache: LogoCache;
}): Promise<ScheduledNotificationTotals> {
	const {
		supabase,
		logger,
		sendEmail,
		getSmsSender,
		getTelegramSender,
		marketSession,
		schedulerQuoteCache,
		logoCache,
	} = options;

	// Use actual UTC time — NOT rounded to end-of-minute like the old single-pass approach.
	// Users set times at minute granularity so next_send_at is always at :00 seconds.
	// The two-pass system at ~:00 and ~:30 naturally covers the full minute window.
	const currentTime = DateTime.utc();
	const currentTimeIso = toIsoOrThrow(currentTime, "Failed to format UTC ISO string");

	/* ============= Phase 1: DELIVER staged ============= */
	let stagedStats = { ...EMPTY_TOTALS };
	let deliveredUserTypes = new Set<string>();
	try {
		const staged = await deliverStagedNotifications({
			supabase,
			logger,
			currentTime,
			sendEmail,
			getSmsSender,
			getTelegramSender,
		});
		stagedStats = staged.stats;
		deliveredUserTypes = staged.deliveredUserTypes;

		if (
			stagedStats.emailsSent > 0 ||
			stagedStats.smsSent > 0 ||
			stagedStats.telegramSent > 0 ||
			stagedStats.skipped > 0
		) {
			logger.info("Staged notifications delivered", {
				action: "staged_deliver",
				...stagedStats,
			});
		}
	} catch (error) {
		logger.error(
			"Staged delivery phase failed (falling back to full pipeline)",
			{ action: "staged_deliver" },
			error,
		);
	}

	/* ============= Phase 2: DELIVER fallback (full pipeline for non-staged users) ============= */
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

	// Filter out users already delivered from staging so we don't double-send.
	// The deliveredUserTypes set uses "userId:type" keys (e.g. "abc-123:market").
	const fallbackMarketUsers = marketUsers.filter((u) => !deliveredUserTypes.has(`${u.id}:market`));
	const fallbackDailyUsers = dailyUsers.filter((u) => !deliveredUserTypes.has(`${u.id}:daily`));

	// Batch-load user assets for market + asset-events users first (single query).
	// Derive unique symbols from the map for price fetching to avoid a redundant DB round-trip.
	const userAssetsUserIds = [...fallbackMarketUsers.map((u) => u.id)];
	let userAssetsMap: UserAssetsMap = new Map();
	if (userAssetsUserIds.length > 0) {
		try {
			userAssetsMap = await batchLoadUserAssets(supabase, userAssetsUserIds, {
				includeLogoData: true,
			});
		} catch (error) {
			logger.error(
				"Failed to batch-load user assets (aborting fallback pass)",
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
	// Symbols Massive recognized but had no live trade in the current session
	// (typical for illiquid pre/after-hours tickers). The scheduled-notification
	// renderer uses this to show "no pre-market trades" / "no after-hours trades"
	// instead of the generic "price unavailable".
	const marketNoSessionTrade: Set<string> = new Set();
	const marketOpen = marketSession === "regular";

	let marketUserSymbols: string[] = [];
	if (fallbackMarketUsers.length > 0) {
		marketUserSymbols = [
			...new Set(
				fallbackMarketUsers.flatMap((u) => {
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

	// Fetch market closure once for market-scheduled banners and daily notifications.
	const needsClosureInfo =
		!marketOpen && (fallbackDailyUsers.length > 0 || fallbackMarketUsers.length > 0);
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

	// Process fallback market users
	for (let index = 0; index < fallbackMarketUsers.length; index += USER_PROCESS_BATCH_SIZE) {
		const batch = fallbackMarketUsers.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processMarketScheduledUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
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

	// Dispatch each fallback daily notification user in-process
	// already loaded above so dispatch doesn't re-fetch the user row + prefs per user.
	if (fallbackDailyUsers.length > 0) {
		for (let index = 0; index < fallbackDailyUsers.length; index += DAILY_DISPATCH_BATCH_SIZE) {
			const batch = fallbackDailyUsers.slice(index, index + DAILY_DISPATCH_BATCH_SIZE);
			const dispatchResults = await Promise.allSettled(
				batch.map((user) =>
					dispatchDailyDigestUser({
						userId: user.id,
						user,
						currentTimeIso,
						marketOpen,
						supabase,
						sendEmail,
						getSmsSender,
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
						smsSent: 0,
						smsFailed: 0,
						telegramSent: 0,
						telegramFailed: 0,
					});
				}
			}
		}
	}

	const fallbackTotals = results.reduce((acc, curr) => mergeTotals(acc, curr), {
		...EMPTY_TOTALS,
	});

	/* ============= Phase 3: PRE-COMPUTE for upcoming daily-digest users ============= */
	try {
		const preDaily = await precomputeDailyDigest({
			supabase,
			logger,
			currentTime,
			marketOpen,
		});
		if (preDaily.skipped > 0) {
			logger.info("Pre-compute phase completed", {
				action: "precompute",
				dailySkipped: preDaily.skipped,
			});
		}
	} catch (error) {
		logger.warn("Pre-compute phase failed (non-fatal)", { action: "precompute" }, error);
	}

	return mergeTotals(stagedStats, fallbackTotals);
}

/**
 * Run the scheduled notification cron (two-pass).
 */
export async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<
	ScheduledNotificationTotals & {
		priceAlerts?: PriceAlertTotals;
		priceTargets?: PriceTargetTotals;
		flatPriceAlerts?: FlatPriceAlertTotals;
	}
> {
	const { supabase, logger } = options;

	// Purge old asset_snapshots (60-minute retention) so the table does not grow unbounded
	try {
		const purged = await purgeOldAssetSnapshots(supabase);
		if (purged > 0) {
			logger.info("Purged old asset snapshots", {
				action: "purge_asset_snapshots",
				purgedCount: purged,
			});
		}
	} catch (error) {
		logger.warn(
			"Failed to purge old asset snapshots (non-fatal)",
			{ action: "purge_asset_snapshots" },
			error,
		);
	}

	// Resolve market session once per scheduler invocation — passed to price alerts,
	// both fallback passes, and precompute to avoid redundant Massive status calls.
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

	// Run price alerts first — this also returns an extended quote map
	// that could be reused by scheduled notifications to avoid duplicate API calls.
	let priceAlertTotals: PriceAlertTotals | undefined;
	let priceAlertQuoteMap: ExtendedQuoteMap | undefined;
	let priceAlertIsMarketOpen: boolean | undefined;
	try {
		const priceAlertResult = await processPriceAlerts({
			supabase,
			marketSession: schedulerMarketSession,
		});
		priceAlertTotals = priceAlertResult.totals;
		priceAlertQuoteMap = priceAlertResult.quoteMap;
		priceAlertIsMarketOpen = priceAlertResult.isMarketOpen;

		if (priceAlertTotals.alertsTriggered > 0) {
			logger.info("Price alerts processed", {
				action: "price_alerts",
				...priceAlertTotals,
			});
		}
	} catch (error) {
		logger.warn("Price alerts processing failed (non-fatal)", { action: "price_alerts" }, error);
	}

	// Quotes fetched for the price-history capture are a SUPERSET of the price-alert map
	// (they add the watched-symbol universe). Hold the merged map so it can seed the
	// scheduler quote cache below — otherwise both passes re-fetch those extra symbols.
	let capturedQuoteMap = priceAlertQuoteMap;
	if (schedulerMarketSession !== "closed") {
		try {
			const cacheSymbols = await getPriceCacheSymbols(supabase);
			const missingSymbols = cacheSymbols.filter((symbol) => {
				const quote = capturedQuoteMap?.get(symbol);
				return quote === undefined || quote === null;
			});
			if (missingSymbols.length > 0) {
				const extraQuotes = await fetchExtendedQuotes(missingSymbols, schedulerMarketSession);
				capturedQuoteMap = new Map(capturedQuoteMap ?? []);
				for (const [symbol, quote] of extraQuotes) {
					capturedQuoteMap.set(symbol, quote);
				}
			}
			if (capturedQuoteMap && capturedQuoteMap.size > 0) {
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

	// Run price target checks — piggybacks on the same market-hours window.
	// Reuses the quote map and market status from price alerts to avoid duplicate API calls.
	let priceTargetTotals: PriceTargetTotals | undefined;
	try {
		priceTargetTotals = await processPriceTargets({
			supabase,
			quoteMap: priceAlertQuoteMap,
			isMarketOpen: priceAlertIsMarketOpen,
		});

		if (priceTargetTotals.targetsTriggered > 0) {
			logger.info("Price targets processed", {
				action: "price_targets",
				...priceTargetTotals,
			});
		}
	} catch (error) {
		logger.warn("Price targets processing failed (non-fatal)", { action: "price_targets" }, error);
	}

	// Run flat price alerts — own state, own users, own emails; shares the
	// quote map and market-hours gating from processPriceAlerts to avoid
	// duplicate Massive snapshot calls. If processPriceAlerts threw, the
	// quote map is undefined and this is skipped — logged so the skip is
	// observable, not silent.
	let flatPriceAlertTotals: FlatPriceAlertTotals | undefined;
	if (priceAlertQuoteMap && priceAlertIsMarketOpen !== undefined) {
		try {
			flatPriceAlertTotals = await processFlatPriceAlerts({
				supabase,
				quoteMap: priceAlertQuoteMap,
				isMarketOpen: priceAlertIsMarketOpen,
			});

			logger.info("Flat price alerts processed", {
				action: "flat_price_alerts",
				...flatPriceAlertTotals,
			});
		} catch (error) {
			logger.warn(
				"Flat price alerts processing failed (non-fatal)",
				{ action: "flat_price_alerts" },
				error,
			);
		}
	} else {
		// Upstream price-alert processing already logged at error if it threw;
		// this is a defensive trace explaining why the downstream step is
		// skipped, not a separate failure to alarm on.
		logger.info("Flat price alerts skipped: upstream quote fetch unavailable", {
			action: "flat_price_alerts",
			hasQuoteMap: Boolean(priceAlertQuoteMap),
			hasMarketStatus: priceAlertIsMarketOpen !== undefined,
		});
	}

	const { sendEmail, getSmsSender, getTelegramSender, logoCache } = createNotificationSenders();
	// Seed from the captured (superset) map so fallback passes reuse the watched-symbol
	// quotes the price-history capture already fetched, instead of re-fetching them.
	const schedulerQuoteCache = createSchedulerQuoteCache(capturedQuoteMap);

	/* ============= Two-pass execution ============= */
	const passStartTime = Date.now();

	// Pass 1: DELIVER staged + fallback + PRE-COMPUTE
	const pass1Totals = await runPass({
		supabase,
		logger,
		sendEmail,
		getSmsSender,
		getTelegramSender,
		marketSession: schedulerMarketSession,
		schedulerQuoteCache,
		logoCache,
	});

	// Wait until 30 seconds have elapsed since the start of pass 1
	const elapsed = Date.now() - passStartTime;
	const passDelayMs = getPassDelayMs();
	const waitMs = Math.max(0, passDelayMs - elapsed);
	if (waitMs > 0) {
		// Wait silently — pass lifecycle is an implementation detail
		await realDelay(waitMs);
	}

	// Pass 2: DELIVER staged + fallback + PRE-COMPUTE
	const pass2Totals = await runPass({
		supabase,
		logger,
		sendEmail,
		getSmsSender,
		getTelegramSender,
		marketSession: schedulerMarketSession,
		schedulerQuoteCache,
		logoCache,
	});

	const combinedTotals = mergeTotals(pass1Totals, pass2Totals);

	return {
		...combinedTotals,
		priceAlerts: priceAlertTotals,
		priceTargets: priceTargetTotals,
		flatPriceAlerts: flatPriceAlertTotals,
	};
}
