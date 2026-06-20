import { rootLogger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import { createLogoCache } from "../messaging/logo-fetcher";
import { isFacetEnabled, type PrefRow } from "../messaging/notification-prefs";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import {
	type ExtendedQuoteMap,
	fetchExtendedQuotes,
	getCurrentMarketSession,
	type MarketSession,
} from "../providers/price-fetcher";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider } from "../schedule/sms-sender";
import { createTelegramSenderProvider } from "../schedule/telegram-sender";
import { deliverPriceTargetAlert, type PriceTargetDeliveryStats } from "./delivery";

export interface PriceTargetUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	/** Linked Telegram chat (null when never linked); gates the Telegram delivery branch. */
	telegram_chat_id: number | null;
	/** True after a verified outbound 403 ("bot blocked"); suppresses Telegram delivery. */
	telegram_opted_out: boolean;
	/** Per-option channel preferences (single source of truth for all channels). */
	prefs: PrefRow[];
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
	triggered_at: string | null;
	triggered_price: number | null;
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
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};

	// Only process during market hours (use pre-fetched status when available)
	// price-targets only fires in regular hours; resolve session once and reuse
	// for fetchExtendedQuotes below to avoid a second /v1/marketstatus/now call.
	const session: MarketSession = options.isMarketOpen ? "regular" : await getCurrentMarketSession();
	const isMarketOpen = session === "regular";
	if (!isMarketOpen) {
		return totals;
	}

	// Fetch all active price targets joined with user preferences
	const { data: targetRows, error: targetsError } = await (supabase
		.from("price_targets")
		.select(
			"user_id, symbol, target_price, direction, triggered_at, triggered_price",
		) as unknown as Promise<{
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
			"id, email, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, telegram_chat_id, telegram_opted_out",
		)
		.in("id", userIds) as unknown as Promise<{
		data: Omit<PriceTargetUser, "prefs">[] | null;
		error: unknown;
	}>);

	if (usersError) {
		rootLogger.error("Failed to fetch price target users", { action: "price_targets" }, usersError);
		return totals;
	}

	if (!userData || userData.length === 0) {
		return totals;
	}

	// Per-option price_targets facet lives in notification_preferences; batch-load it.
	const usersWithPrefs = await attachPrefsToUsers(supabase, userData);
	const userMap = new Map<string, PriceTargetUser>();
	for (const u of usersWithPrefs) {
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
			const additionalQuotes = await fetchExtendedQuotes(missingSymbols, session);
			for (const [symbol, quote] of additionalQuotes) {
				quoteMap.set(symbol, quote);
			}
		}
	} else {
		quoteMap = await fetchExtendedQuotes(uniqueSymbols, session);
	}

	// Fetch icon URLs for triggered symbols (for email logos)
	const iconUrlMap = new Map<string, string | null>();
	const iconBase64Map = new Map<string, string | null>();
	const hasAnyEmailTargets = activeTargets.some((t) => {
		const u = userMap.get(t.user_id);
		return u ? isFacetEnabled(u.prefs, "price_targets", "email") : false;
	});
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
	const getTelegramSender = createTelegramSenderProvider();
	let telegramSender: ReturnType<typeof getTelegramSender>["sender"] | null = null;
	const logoCache = createLogoCache();

	for (const target of activeTargets) {
		totals.targetsChecked++;

		const user = userMap.get(target.user_id);
		if (!user) continue;

		const pendingDelivery = target.triggered_at != null && target.triggered_price != null;
		let currentPrice: number;
		let triggeredTarget: TriggeredPriceTarget;

		if (pendingDelivery) {
			currentPrice = target.triggered_price as number;
			triggeredTarget = {
				symbol: target.symbol,
				targetPrice: target.target_price,
				currentPrice,
				direction: target.direction as "above" | "below",
				iconUrl: iconUrlMap.get(target.symbol) ?? null,
				iconBase64: iconBase64Map.get(target.symbol) ?? null,
			};
		} else {
			const quote = quoteMap.get(target.symbol);
			if (!quote) continue;

			currentPrice = quote.price;
			const isTriggered =
				(target.direction === "above" && currentPrice >= target.target_price) ||
				(target.direction === "below" && currentPrice <= target.target_price);

			if (!isTriggered) continue;

			triggeredTarget = {
				symbol: target.symbol,
				targetPrice: target.target_price,
				currentPrice,
				direction: target.direction as "above" | "below",
				iconUrl: iconUrlMap.get(target.symbol) ?? null,
				iconBase64: iconBase64Map.get(target.symbol) ?? null,
			};
		}

		const hasEnabledChannel =
			isFacetEnabled(user.prefs, "price_targets", "email") ||
			(isFacetEnabled(user.prefs, "price_targets", "sms") &&
				user.sms_notifications_enabled &&
				!user.sms_opted_out) ||
			// Telegram-linked users may receive the alert even with email/SMS off; the
			// per-option Telegram pref is checked in deliverPriceTargetAlert.
			isTelegramChannelUsable(user);

		if (!hasEnabledChannel) {
			const { error: deleteError } = await supabase
				.from("price_targets")
				.delete()
				.eq("user_id", target.user_id)
				.eq("symbol", target.symbol);
			if (deleteError) {
				rootLogger.error(
					"Failed to delete price target with no enabled channels",
					{ userId: target.user_id, symbol: target.symbol },
					deleteError,
				);
			}
			continue;
		}

		if (!pendingDelivery) {
			const { data: claimedRows, error: markPendingError } = await supabase
				.from("price_targets")
				.update({
					triggered_at: new Date().toISOString(),
					triggered_price: currentPrice,
				})
				.eq("user_id", target.user_id)
				.eq("symbol", target.symbol)
				.eq("target_price", target.target_price)
				.eq("direction", target.direction)
				.is("triggered_at", null)
				.select("user_id");

			if (markPendingError) {
				rootLogger.error(
					"Failed to mark price target as pending delivery",
					{ userId: target.user_id, symbol: target.symbol },
					markPendingError,
				);
				continue;
			}

			// Zero rows means a concurrent scheduler invocation already claimed
			// this target (the .is("triggered_at", null) guard held). Skip to
			// avoid a duplicate "price target hit" alert. PostgREST returns
			// error: null whether the UPDATE matched 1 row or 0, so the row
			// count is the only reliable signal that this run won the CAS.
			if (!claimedRows || claimedRows.length === 0) {
				rootLogger.info("Price target already claimed by another run; skipping", {
					userId: target.user_id,
					symbol: target.symbol,
				});
				continue;
			}
		}

		// This run owns the target now — it either won the CAS above or is
		// resuming a prior claim (pendingDelivery). Count it once, after the
		// claim check, so a run that lost the CAS doesn't inflate the metric.
		totals.targetsTriggered++;

		// Initialize SMS sender lazily
		if (isFacetEnabled(user.prefs, "price_targets", "sms") && !smsSender) {
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

		// Initialize Telegram sender lazily for any user with a usable channel; the
		// per-option pref is checked inside deliverPriceTargetAlert.
		if (isTelegramChannelUsable(user) && !telegramSender) {
			try {
				telegramSender = getTelegramSender().sender;
			} catch (error) {
				rootLogger.error(
					"Failed to initialize Telegram sender for price targets",
					{ action: "price_targets" },
					error,
				);
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
				sendTelegram: telegramSender,
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
					"Failed to delete triggered price target after delivery",
					{ userId: target.user_id, symbol: target.symbol },
					deleteError,
				);
			}
		}
	}

	return totals;
}
