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
import { processAssetEventsUser } from "../asset-events/process";
import { fetchAssetEventsUsers } from "../asset-events/query";
import { dispatchDailyDigestUser } from "../daily-digest/dispatch";
import { fetchDailyDigestUsers } from "../daily-digest/query";
import type { Logger } from "../logging";
import {
	type FlatPriceAlertTotals,
	processFlatPriceAlerts,
} from "../market-notifications/flat-alerts/process";
import {
	type PriceAlertTotals,
	processPriceAlerts,
} from "../market-notifications/process";
import { processMarketScheduledUser } from "../market-notifications/scheduled/process";
import { fetchMarketScheduledUsers } from "../market-notifications/scheduled/query";
import { purgeOldAssetSnapshots } from "../market-notifications/snapshot-store";
import { createEmailSender } from "../messaging/email/utils";
import {
	type PriceTargetTotals,
	processPriceTargets,
} from "../price-targets/process";
import {
	type AssetPriceMap,
	type ExtendedQuoteMap,
	fetchAssetPrices,
	fetchMarketStatus,
} from "../providers/price-fetcher";
import { deliverStagedNotifications } from "../staged-notifications/deliver";
import {
	precomputeDailyDigest,
	precomputeMarketScheduled,
} from "../staged-notifications/precompute";
import { toIsoOrThrow } from "../time/format";
import {
	getUsMarketClosureInfoForInstant,
	type MarketClosureInfo,
} from "../time/market-calendar";
import {
	batchLoadUserAssets,
	type ScheduledNotificationTotals,
	type SupabaseAdminClient,
	USER_PROCESS_BATCH_SIZE,
	type UserAssetsMap,
} from "./helpers";
import { createSmsSenderProvider } from "./sms-sender";

/** Daily fan-out batch size for dispatching digest processing. */
const DAILY_DISPATCH_BATCH_SIZE = (() => {
	const raw = process.env.SCHEDULE_DAILY_DISPATCH_BATCH_SIZE;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();

/** Return the delay between pass 1 and pass 2 (ms). */
function getPassDelayMs(): number {
	const raw = process.env.SCHEDULE_PASS_DELAY_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
}

const EMPTY_TOTALS: ScheduledNotificationTotals = {
	skipped: 0,
	logFailures: 0,
	emailsSent: 0,
	emailsFailed: 0,
	smsSent: 0,
	smsFailed: 0,
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
	};
}

/** Run a single pass: deliver staged → fallback → pre-compute. */
async function runPass(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: ReturnType<typeof createEmailSender>;
	getSmsSender: ReturnType<typeof createSmsSenderProvider>;
	priceAlertQuoteMap?: ExtendedQuoteMap;
	/** When true, run asset events processing (only in the first pass). */
	includeAssetEvents: boolean;
}): Promise<ScheduledNotificationTotals> {
	const { supabase, logger, sendEmail, getSmsSender, priceAlertQuoteMap } =
		options;

	// Use actual UTC time — NOT rounded to end-of-minute like the old single-pass approach.
	// Users set times at minute granularity so next_send_at is always at :00 seconds.
	// The two-pass system at ~:00 and ~:30 naturally covers the full minute window.
	const currentTime = DateTime.utc();
	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format UTC ISO string",
	);

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
		});
		stagedStats = staged.stats;
		deliveredUserTypes = staged.deliveredUserTypes;

		if (
			stagedStats.emailsSent > 0 ||
			stagedStats.smsSent > 0 ||
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
	const [marketUsers, dailyUsers, assetEventsUsers] = await Promise.all([
		fetchMarketScheduledUsers({
			supabase,
			logger,
			forceSend: false,
			currentTimeIso,
		}),
		fetchDailyDigestUsers({
			supabase,
			logger,
			forceSend: false,
			currentTimeIso,
		}),
		options.includeAssetEvents
			? fetchAssetEventsUsers({
					supabase,
					logger,
					forceSend: false,
					currentTimeIso,
				})
			: Promise.resolve([]),
	]);

	// Filter out users already delivered from staging so we don't double-send.
	// The deliveredUserTypes set uses "userId:type" keys (e.g. "abc-123:market").
	const fallbackMarketUsers = marketUsers.filter(
		(u) => !deliveredUserTypes.has(`${u.id}:market`),
	);
	const fallbackDailyUsers = dailyUsers.filter(
		(u) => !deliveredUserTypes.has(`${u.id}:daily`),
	);

	// Batch-load user assets for market + asset-events users first (single query).
	// Derive unique symbols from the map for price fetching to avoid a redundant DB round-trip.
	const userAssetsUserIds = [
		...fallbackMarketUsers.map((u) => u.id),
		...assetEventsUsers.map((u) => u.id),
	];
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
	let priceMap: AssetPriceMap = new Map();
	const hasAnyUsers =
		fallbackMarketUsers.length > 0 ||
		fallbackDailyUsers.length > 0 ||
		assetEventsUsers.length > 0;
	const marketStatusPromise = hasAnyUsers ? fetchMarketStatus() : null;

	if (fallbackMarketUsers.length > 0) {
		const uniqueSymbols = [
			...new Set(
				fallbackMarketUsers.flatMap((u) => {
					const assets = userAssetsMap.get(u.id);
					return assets ? assets.map((a) => a.symbol) : [];
				}),
			),
		];

		if (uniqueSymbols.length > 0) {
			// Reuse quotes from price alerts when available to avoid duplicate API calls
			if (priceAlertQuoteMap && priceAlertQuoteMap.size > 0) {
				const missingSymbols: string[] = [];
				for (const symbol of uniqueSymbols) {
					const cached = priceAlertQuoteMap.get(symbol);
					if (cached) {
						priceMap.set(symbol, cached);
					} else {
						missingSymbols.push(symbol);
					}
				}
				if (missingSymbols.length > 0) {
					const extraPrices = await fetchAssetPrices(missingSymbols);
					for (const [symbol, price] of extraPrices) {
						priceMap.set(symbol, price);
					}
				}
			} else {
				priceMap = await fetchAssetPrices(uniqueSymbols);
			}
		}
	}

	const marketOpen = marketStatusPromise ? await marketStatusPromise : false;

	// Fetch market closure once for market-scheduled banners and asset-events.
	// Daily digests derive weekend/holiday labels from each user's scheduled send
	// instant inside the worker, so reusing the scheduler's current-time closure
	// info can misclassify digests near US midnight.
	let marketClosureInfo: MarketClosureInfo | null = null;
	const needsClosureInfo =
		!marketOpen &&
		(fallbackDailyUsers.length > 0 ||
			fallbackMarketUsers.length > 0 ||
			assetEventsUsers.length > 0);
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
	for (
		let index = 0;
		index < fallbackMarketUsers.length;
		index += USER_PROCESS_BATCH_SIZE
	) {
		const batch = fallbackMarketUsers.slice(
			index,
			index + USER_PROCESS_BATCH_SIZE,
		);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processMarketScheduledUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
					priceMap,
					marketOpen,
					userAssetsMap,
					marketClosureInfo,
				}),
			),
		);
		results.push(...batchResults);
	}

	// In-process: process asset events users in batches (first pass only)
	for (
		let index = 0;
		index < assetEventsUsers.length;
		index += USER_PROCESS_BATCH_SIZE
	) {
		const batch = assetEventsUsers.slice(
			index,
			index + USER_PROCESS_BATCH_SIZE,
		);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processAssetEventsUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
					userAssetsMap,
					marketClosureInfo,
				}),
			),
		);
		results.push(...batchResults);
	}

	// Fan-out: dispatch each fallback daily user to its own serverless function
	if (fallbackDailyUsers.length > 0) {
		for (
			let index = 0;
			index < fallbackDailyUsers.length;
			index += DAILY_DISPATCH_BATCH_SIZE
		) {
			const batch = fallbackDailyUsers.slice(
				index,
				index + DAILY_DISPATCH_BATCH_SIZE,
			);
			const dispatchResults = await Promise.allSettled(
				batch.map((user) =>
					dispatchDailyDigestUser({
						userId: user.id,
						currentTimeIso,
						marketOpen,
						supabase,
						sendEmail,
						getSmsSender,
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
					});
				}
			}
		}
	}

	const fallbackTotals = results.reduce((acc, curr) => mergeTotals(acc, curr), {
		...EMPTY_TOTALS,
	});

	/* ============= Phase 3: PRE-COMPUTE for upcoming users ============= */
	try {
		const [preMarket, preDaily] = await Promise.all([
			precomputeMarketScheduled({ supabase, logger, currentTime }),
			precomputeDailyDigest({ supabase, logger, currentTime }),
		]);
		// Pre-compute stats are informational only (no actual delivery)
		if (preMarket.skipped > 0 || preDaily.skipped > 0) {
			logger.info("Pre-compute phase completed", {
				action: "precompute",
				marketSkipped: preMarket.skipped,
				dailySkipped: preDaily.skipped,
			});
		}
	} catch (error) {
		logger.error(
			"Pre-compute phase failed (non-fatal)",
			{ action: "precompute" },
			error,
		);
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
		logger.error(
			"Failed to purge old asset snapshots (non-fatal)",
			{ action: "purge_asset_snapshots" },
			error,
		);
	}

	// Run price alerts first — this also returns an extended quote map
	// that could be reused by scheduled notifications to avoid duplicate API calls.
	let priceAlertTotals: PriceAlertTotals | undefined;
	let priceAlertQuoteMap: ExtendedQuoteMap | undefined;
	let priceAlertIsMarketOpen: boolean | undefined;
	try {
		const priceAlertResult = await processPriceAlerts({ supabase });
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
		logger.error(
			"Price alerts processing failed (non-fatal)",
			{ action: "price_alerts" },
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
		logger.error(
			"Price targets processing failed (non-fatal)",
			{ action: "price_targets" },
			error,
		);
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
			logger.error(
				"Flat price alerts processing failed (non-fatal)",
				{ action: "flat_price_alerts" },
				error,
			);
		}
	} else {
		logger.warn("Flat price alerts skipped: upstream quote fetch unavailable", {
			action: "flat_price_alerts",
			hasQuoteMap: Boolean(priceAlertQuoteMap),
			hasMarketStatus: priceAlertIsMarketOpen !== undefined,
		});
	}

	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();

	/* ============= Two-pass execution ============= */
	const passStartTime = Date.now();

	// Pass 1: DELIVER staged + fallback + PRE-COMPUTE
	const pass1Totals = await runPass({
		supabase,
		logger,
		sendEmail,
		getSmsSender,
		priceAlertQuoteMap,
		includeAssetEvents: true,
	});

	// Wait until 30 seconds have elapsed since the start of pass 1
	const elapsed = Date.now() - passStartTime;
	const passDelayMs = getPassDelayMs();
	const waitMs = Math.max(0, passDelayMs - elapsed);
	if (waitMs > 0) {
		// Wait silently — pass lifecycle is an implementation detail
		await realDelay(waitMs);
	}

	// Pass 2: DELIVER staged + fallback + PRE-COMPUTE (no asset events)
	const pass2Totals = await runPass({
		supabase,
		logger,
		sendEmail,
		getSmsSender,
		includeAssetEvents: false,
	});

	const combinedTotals = mergeTotals(pass1Totals, pass2Totals);

	return {
		...combinedTotals,
		priceAlerts: priceAlertTotals,
		priceTargets: priceTargetTotals,
		flatPriceAlerts: flatPriceAlertTotals,
	};
}
