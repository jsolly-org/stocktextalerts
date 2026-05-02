import { rootLogger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import { createLogoCache } from "../messaging/logo-fetcher";
import {
	type ExtendedQuoteMap,
	fetchExtendedQuotes,
	fetchMarketStatus,
} from "../providers/price-fetcher";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider } from "../schedule/sms-sender";
import { deliverPriceTargetAlert, type PriceTargetDeliveryStats } from "./delivery";

export interface PriceTargetUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	price_targets_include_email: boolean;
	price_targets_include_sms: boolean;
}

export interface TriggeredPriceTarget {
	symbol: string;
	targetPrice: number;
	currentPrice: number;
	direction: "above" | "below";
	iconUrl?: string | null;
	iconBase64?: string | null;
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
 * Accepts an optional `isMarketOpen` to reuse market status already fetched by processPriceAlerts.
 */
export async function processPriceTargets(options: {
	supabase: SupabaseAdminClient;
	quoteMap?: ExtendedQuoteMap;
	isMarketOpen?: boolean;
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

	// Only process during market hours (use pre-fetched status when available)
	const isMarketOpen = options.isMarketOpen ?? (await fetchMarketStatus());
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
		rootLogger.error("Failed to fetch price targets", { action: "price_targets" }, targetsError);
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
			"id, email, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, price_targets_include_email, price_targets_include_sms",
		)
		.in("id", userIds) as unknown as Promise<{
		data: PriceTargetUser[] | null;
		error: unknown;
	}>);

	if (usersError) {
		rootLogger.error("Failed to fetch price target users", { action: "price_targets" }, usersError);
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

	// Fetch icon URLs for triggered symbols (for email logos)
	const iconUrlMap = new Map<string, string | null>();
	const iconBase64Map = new Map<string, string | null>();
	const hasAnyEmailTargets = activeTargets.some(
		(t) => userMap.get(t.user_id)?.price_targets_include_email,
	);
	if (hasAnyEmailTargets) {
		const { data: iconRows, error: iconRowsError } = await supabase
			.from("assets")
			.select("symbol, icon_url, icon_base64")
			.in("symbol", uniqueSymbols);
		if (iconRowsError) {
			rootLogger.error(
				"Failed to fetch asset icons for price target alerts",
				{ action: "price_targets" },
				iconRowsError,
			);
		}
		for (const row of iconRows ?? []) {
			const r = row as {
				symbol: string;
				icon_url: string | null;
				icon_base64: string | null;
			};
			iconUrlMap.set(r.symbol, r.icon_url);
			iconBase64Map.set(r.symbol, r.icon_base64);
		}
	}

	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();
	let smsSender: ReturnType<typeof getSmsSender>["sender"] | null = null;
	const logoCache = createLogoCache();

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
			iconUrl: iconUrlMap.get(target.symbol) ?? null,
			iconBase64: iconBase64Map.get(target.symbol) ?? null,
		};

		// Initialize SMS sender lazily
		if (user.price_targets_include_sms && !smsSender) {
			try {
				smsSender = getSmsSender().sender;
			} catch (error) {
				rootLogger.error(
					"Failed to initialize SMS sender for price targets",
					{ action: "price_targets" },
					error,
				);
			}
		}

		try {
			await deliverPriceTargetAlert({
				user,
				target: triggeredTarget,
				supabase,
				sendEmail,
				sendSms: smsSender,
				stats: totals,
				logoCache,
			});
		} catch (error) {
			rootLogger.error(
				"Failed to deliver price target alert",
				{ userId: target.user_id, symbol: target.symbol },
				error,
			);
			totals.logFailures++;
		}

		// Always clear the triggered target so it is not re-triggered on every cron run.
		// Clear even when no channel was enabled (user had both email and SMS off), so
		// the row does not accumulate and loop indefinitely.
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

	return totals;
}
