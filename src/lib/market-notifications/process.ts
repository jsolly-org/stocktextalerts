import { rootLogger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import type { CompanyNewsItem } from "../providers/company-news";
import {
	type ExtendedQuoteMap,
	fetchExtendedQuotes,
	fetchMarketStatus,
} from "../providers/price-fetcher";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider } from "../schedule/sms-sender";
import {
	type AnomalyResult,
	computeAnomalyScore,
	computePriceOnlyScore,
	getThresholdForSensitivity,
} from "./anomaly-detection";
import { deliverPriceAlert, type PriceAlertDeliveryStats } from "./delivery";
import { enrichAlert, fetchBreakingNews } from "./enrichment";
import {
	getSnapshotsForSymbols,
	purgeOldSnapshots,
	storeSnapshots,
} from "./snapshot-store";
import { claimCooldown, fetchPriceAlertUsers } from "./users";

/** Fetch news when price-only score is >= 50% of the aggressive threshold. */
const NEWS_FETCH_SCORE_RATIO = 0.5;

/** The most permissive threshold (Aggressive) — used to decide if a symbol could trigger for anyone. */
const AGGRESSIVE_THRESHOLD = getThresholdForSensitivity(3);

export interface PriceAlertTotals extends PriceAlertDeliveryStats {
	symbolsChecked: number;
	alertsTriggered: number;
	cooldownSkips: number;
}

/** Fetch symbols with earnings within ~2 calendar days from the asset_events table. */
async function fetchEarningsSymbols(
	supabase: SupabaseAdminClient,
): Promise<Set<string>> {
	try {
		const now = new Date();
		const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const to = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const { data, error } = await supabase
			.from("asset_events")
			.select("symbol")
			.eq("event_type", "earnings")
			.gte("event_date", from)
			.lte("event_date", to);
		if (error) {
			rootLogger.warn("Failed to query asset_events for price alerts", {
				error: error.message,
			});
			return new Set();
		}
		return new Set((data ?? []).map((e) => e.symbol));
	} catch (err) {
		rootLogger.warn(
			"Failed to fetch earnings symbols for price alerts",
			{},
			err,
		);
		return new Set();
	}
}

/** Process market movement price alerts and return totals plus a reusable quote map. */
export async function processPriceAlerts(options: {
	supabase: SupabaseAdminClient;
}): Promise<{
	totals: PriceAlertTotals;
	quoteMap: ExtendedQuoteMap;
}> {
	const { supabase } = options;
	const totals: PriceAlertTotals = {
		symbolsChecked: 0,
		alertsTriggered: 0,
		cooldownSkips: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		logFailures: 0,
	};
	const emptyResult = { totals, quoteMap: new Map<string, null>() };

	// 1. Check market status — skip if closed
	const isMarketOpen = await fetchMarketStatus();
	if (!isMarketOpen) {
		return emptyResult;
	}

	// 2. Query all distinct symbols tracked by any user
	const { data: allUserAssets, error: assetsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (assetsError) {
		rootLogger.error(
			"Failed to load user_assets for price alerts",
			{ action: "price_alerts" },
			assetsError,
		);
		return emptyResult;
	}

	const uniqueSymbols = [
		...new Set((allUserAssets ?? []).map((a) => a.symbol)),
	];
	if (uniqueSymbols.length === 0) {
		return emptyResult;
	}

	// 3. Fetch extended quotes + earnings calendar in parallel
	const [quoteMap, earningsSymbols] = await Promise.all([
		fetchExtendedQuotes(uniqueSymbols),
		fetchEarningsSymbols(supabase),
	]);

	// 4. Store snapshots + fetch historical snapshots
	await storeSnapshots(supabase, quoteMap);
	const snapshotMap = await getSnapshotsForSymbols(supabase, uniqueSymbols);

	// 5. Purge old snapshots (fire-and-forget)
	purgeOldSnapshots(supabase).catch((err) =>
		rootLogger.warn("Snapshot purge failed", {}, err),
	);

	// 6. First pass: identify candidate symbols (price-only score above news-fetch threshold)
	const newsFetchThreshold = AGGRESSIVE_THRESHOLD * NEWS_FETCH_SCORE_RATIO;

	const candidates: Array<{
		symbol: string;
		hasEarningsNearby: boolean;
	}> = [];

	for (const symbol of uniqueSymbols) {
		totals.symbolsChecked++;
		const quote = quoteMap.get(symbol);
		if (!quote) continue;

		const snapshots = snapshotMap.get(symbol) ?? [];
		const hasEarningsNearby = earningsSymbols.has(symbol);

		const priceScore = computePriceOnlyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby,
			sensitivity: 3, // use most permissive for pre-screening
		});

		if (priceScore >= newsFetchThreshold) {
			candidates.push({ symbol, hasEarningsNearby });
		}
	}

	// 7. Parallel news fetch for all candidates
	const newsMap = new Map<string, CompanyNewsItem[]>();
	if (candidates.length > 0) {
		const newsResults = await Promise.all(
			candidates.map(async ({ symbol }) => {
				const news = await fetchBreakingNews(symbol);
				return { symbol, news };
			}),
		);
		for (const { symbol, news } of newsResults) {
			newsMap.set(symbol, news);
		}
	}

	// 8. Second pass: full scoring with news — score once per symbol at Aggressive threshold
	const triggeredAlerts: Array<{
		symbol: string;
		news: CompanyNewsItem[];
		anomalyResult: AnomalyResult;
	}> = [];

	for (const { symbol, hasEarningsNearby } of candidates) {
		const quote = quoteMap.get(symbol);
		if (!quote) continue;

		const snapshots = snapshotMap.get(symbol) ?? [];
		const news = newsMap.get(symbol) ?? [];

		const result = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news,
			hasEarningsNearby,
			sensitivity: 3, // score at most permissive — filter per-user during delivery
		});

		if (result.triggered) {
			triggeredAlerts.push({ symbol, news, anomalyResult: result });
			totals.alertsTriggered++;
		}
	}

	if (triggeredAlerts.length === 0) {
		return { totals, quoteMap };
	}

	// 9. Fetch price alert users
	const users = await fetchPriceAlertUsers(supabase);
	if (users.length === 0) {
		return { totals, quoteMap };
	}

	// 10. Build user→symbols mapping from user_assets
	const { data: userAssetRows, error: userAssetsError } = await supabase
		.from("user_assets")
		.select("user_id, symbol")
		.in(
			"user_id",
			users.map((u) => u.id),
		);

	if (userAssetsError) {
		rootLogger.error(
			"Failed to load user_assets for price alert delivery",
			{ action: "price_alerts" },
			userAssetsError,
		);
		return { totals, quoteMap };
	}

	const userSymbolMap = new Map<string, Set<string>>();
	for (const row of userAssetRows ?? []) {
		const existing = userSymbolMap.get(row.user_id) ?? new Set();
		existing.add(row.symbol);
		userSymbolMap.set(row.user_id, existing);
	}

	// 11. Deliver alerts — filter per user's sensitivity threshold
	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();
	let smsSender: ReturnType<typeof getSmsSender>["sender"] | null = null;

	for (const { symbol, news, anomalyResult } of triggeredAlerts) {
		const quote = quoteMap.get(symbol);
		if (!quote) continue;

		const enrichedAlert = await enrichAlert({
			symbol,
			quote,
			anomalyResult,
			news,
		});

		for (const user of users) {
			// Check if user tracks this symbol
			const userSymbols = userSymbolMap.get(user.id);
			if (!userSymbols?.has(symbol)) continue;

			// Per-user sensitivity filtering: check if score meets this user's threshold
			const userThreshold = getThresholdForSensitivity(
				user.market_asset_price_alert_sensitivity,
			);
			if (anomalyResult.score < userThreshold) continue;

			// Atomically claim cooldown before delivery to avoid duplicate sends.
			const claimed = await claimCooldown(supabase, user.id, symbol);
			if (!claimed) {
				totals.cooldownSkips++;
				continue;
			}

			// Lazy-init SMS sender
			if (user.market_asset_price_alerts_include_sms && !smsSender) {
				try {
					smsSender = getSmsSender().sender;
				} catch {
					rootLogger.warn("Failed to initialize SMS sender for price alerts");
				}
			}

			await deliverPriceAlert({
				user,
				alert: enrichedAlert,
				supabase,
				sendEmail,
				sendSms: smsSender,
				stats: totals,
			});
		}
	}

	return { totals, quoteMap };
}
