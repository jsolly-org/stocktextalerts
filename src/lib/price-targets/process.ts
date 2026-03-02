import { rootLogger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import {
	type ExtendedQuoteMap,
	fetchExtendedQuotes,
	fetchMarketStatus,
} from "../providers/price-fetcher";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider } from "../schedule/sms-sender";
import {
	deliverPriceTargetAlert,
	type PriceTargetDeliveryStats,
} from "./delivery";

export interface PriceTargetUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	market_asset_price_alerts_include_email: boolean;
	market_asset_price_alerts_include_sms: boolean;
}

export interface TriggeredPriceTarget {
	symbol: string;
	targetPrice: number;
	currentPrice: number;
	direction: "above" | "below";
}

export interface PriceTargetTotals extends PriceTargetDeliveryStats {
	targetsChecked: number;
	targetsTriggered: number;
}

interface PriceTargetRow {
	user_id: string;
	symbol: string;
	target_price: number;
	direction: string;
}

/**
 * Process price targets: check all active targets against current prices,
 * deliver notifications for triggered targets, and delete triggered rows.
 *
 * Accepts an optional `quoteMap` to reuse quotes already fetched by processPriceAlerts.
 */
export async function processPriceTargets(options: {
	supabase: SupabaseAdminClient;
	quoteMap?: ExtendedQuoteMap;
}): Promise<PriceTargetTotals> {
	const { supabase } = options;
	const totals: PriceTargetTotals = {
		targetsChecked: 0,
		targetsTriggered: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		logFailures: 0,
	};

	// Only process during market hours
	const isMarketOpen = await fetchMarketStatus();
	if (!isMarketOpen) {
		return totals;
	}

	// Fetch all active price targets joined with user preferences
	const { data: targetRows, error: targetsError } = await (supabase
		.from("price_targets")
		.select("user_id, symbol, target_price, direction") as unknown as Promise<{
		data: PriceTargetRow[] | null;
		error: unknown;
	}>);

	if (targetsError) {
		rootLogger.error(
			"Failed to fetch price targets",
			{ action: "price_targets" },
			targetsError,
		);
		return totals;
	}

	if (!targetRows || targetRows.length === 0) {
		return totals;
	}

	// Fetch users who have active price targets
	const userIds = [...new Set(targetRows.map((t) => t.user_id))];
	const { data: userData, error: usersError } = await (supabase
		.from("users")
		.select(
			"id, email, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, market_asset_price_alerts_include_email, market_asset_price_alerts_include_sms",
		)
		.in("id", userIds) as unknown as Promise<{
		data: PriceTargetUser[] | null;
		error: unknown;
	}>);

	if (usersError) {
		rootLogger.error(
			"Failed to fetch price target users",
			{ action: "price_targets" },
			usersError,
		);
		return totals;
	}

	if (!userData || userData.length === 0) {
		return totals;
	}

	const userMap = new Map<string, PriceTargetUser>();
	for (const u of userData) {
		userMap.set(u.id, u);
	}

	// Filter targets to only those belonging to enabled users
	const activeTargets = targetRows.filter((t) => userMap.has(t.user_id));
	if (activeTargets.length === 0) {
		return totals;
	}

	// Get unique symbols and fetch quotes (reuse provided quoteMap if available)
	const uniqueSymbols = [...new Set(activeTargets.map((t) => t.symbol))];
	let quoteMap = options.quoteMap;

	// Check if we need to fetch any additional symbols not in the provided map
	if (quoteMap) {
		const existingMap = quoteMap;
		const missingSymbols = uniqueSymbols.filter((s) => !existingMap.has(s));
		if (missingSymbols.length > 0) {
			const additionalQuotes = await fetchExtendedQuotes(missingSymbols);
			for (const [symbol, quote] of additionalQuotes) {
				quoteMap.set(symbol, quote);
			}
		}
	} else {
		quoteMap = await fetchExtendedQuotes(uniqueSymbols);
	}

	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();
	let smsSender: ReturnType<typeof getSmsSender>["sender"] | null = null;

	for (const target of activeTargets) {
		totals.targetsChecked++;

		const quote = quoteMap.get(target.symbol);
		if (!quote) continue;

		const currentPrice = quote.price;
		const isTriggered =
			(target.direction === "above" && currentPrice >= target.target_price) ||
			(target.direction === "below" && currentPrice <= target.target_price);

		if (!isTriggered) continue;

		totals.targetsTriggered++;

		const user = userMap.get(target.user_id);
		if (!user) continue;

		const triggeredTarget: TriggeredPriceTarget = {
			symbol: target.symbol,
			targetPrice: target.target_price,
			currentPrice,
			direction: target.direction as "above" | "below",
		};

		// Initialize SMS sender lazily
		if (user.market_asset_price_alerts_include_sms && !smsSender) {
			try {
				smsSender = getSmsSender().sender;
			} catch {
				rootLogger.warn("Failed to initialize SMS sender for price targets");
			}
		}

		let delivered = false;
		try {
			delivered = await deliverPriceTargetAlert({
				user,
				target: triggeredTarget,
				supabase,
				sendEmail,
				sendSms: smsSender,
				stats: totals,
			});
		} catch (error) {
			rootLogger.error(
				"Failed to deliver price target alert",
				{ userId: target.user_id, symbol: target.symbol },
				error,
			);
			totals.logFailures++;
			continue;
		}

		// Delete only the triggered row (by target_price + direction) so a user
		// edit to the same symbol while cron is in flight does not remove the new target.
		if (delivered) {
			const { error: deleteError } = await supabase
				.from("price_targets")
				.delete()
				.eq("user_id", target.user_id)
				.eq("symbol", target.symbol)
				.eq("target_price", target.target_price)
				.eq("direction", target.direction);

			if (deleteError) {
				rootLogger.error(
					"Failed to delete triggered price target",
					{ userId: target.user_id, symbol: target.symbol },
					deleteError,
				);
			}
		}
	}

	return totals;
}
