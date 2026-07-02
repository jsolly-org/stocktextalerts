import type { SupabaseAdminClient } from "../db/supabase";
import type { PriceTargetDirection } from "../db/types";
import { rootLogger } from "../logging";
import { fetchExtendedQuotes } from "../market-data/prices";
import { getCurrentMarketSession } from "../market-data/session";
import { isEmailChannelUsable } from "../messaging/email/eligibility";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import { isFacetEnabled } from "../messaging/notification-prefs";
import { createNotificationSenders } from "../messaging/senders";
import { isSmsChannelUsable } from "../messaging/sms/index";
import { isTelegramChannelUsable, shouldSendTelegram } from "../messaging/telegram/eligibility";
import { computeDeliveryRetryDelayMs } from "../schedule/retry-delays";
import type { ExtendedQuoteMap, MarketSession } from "../types";
import { deliverPriceTargetAlert } from "./delivery";
import type {
	PriceTargetDeliveryOutcome,
	PriceTargetTotals,
	PriceTargetUser,
	TriggeredPriceTarget,
} from "./types";

/** Max delivery rounds before a triggered-but-undeliverable target is cleared
 *  (tombstoned with an error log). Mirrors `MAX_NOTIFICATION_RETRIES` for
 *  scheduled notifications. */
const MAX_PRICE_TARGET_DELIVERY_ATTEMPTS = 3;

interface PriceTargetRow {
	user_id: string;
	symbol: string;
	target_price: number;
	direction: PriceTargetDirection;
	triggered_at: string | null;
	triggered_price: number | null;
	attempt_count: number;
	next_retry_at: string | null;
	email_delivered_at: string | null;
	sms_delivered_at: string | null;
	telegram_delivered_at: string | null;
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
		deliveryErrors: 0,
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
			"user_id, symbol, target_price, direction, triggered_at, triggered_price, attempt_count, next_retry_at, email_delivered_at, sms_delivered_at, telegram_delivered_at",
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
			"id, email, email_notifications_enabled, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, telegram_chat_id, telegram_opted_out",
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
		return u ? isEmailChannelUsable(u) && isFacetEnabled(u.prefs, "price_targets", "email") : false;
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

	const { sendEmail, getSmsSender, getTelegramSender, logoCache } = createNotificationSenders();
	let smsSender: ReturnType<typeof getSmsSender>["sender"] | null = null;
	let telegramSender: ReturnType<typeof getTelegramSender>["sender"] | null = null;

	/** Clear (delete) a triggered price target by its primary key, logging on failure. */
	const clearTarget = async (t: PriceTargetRow, reason: string): Promise<void> => {
		const { error } = await supabase
			.from("price_targets")
			.delete()
			.eq("user_id", t.user_id)
			.eq("symbol", t.symbol)
			.eq("target_price", t.target_price)
			.eq("direction", t.direction);
		if (error) {
			rootLogger.error(
				`Failed to clear price target (${reason})`,
				{ userId: t.user_id, symbol: t.symbol },
				error,
			);
		}
	};

	for (const target of activeTargets) {
		totals.targetsChecked++;

		const user = userMap.get(target.user_id);
		if (!user) continue;

		// Channels that are both wanted (per-option facet) AND usable for this user —
		// the same predicates `deliverPriceTargetAlert` uses. A channel that can never
		// deliver (e.g. SMS facet on but unverified phone) is not "required", so it
		// neither blocks the target from clearing nor forces a doomed retry loop.
		const required = {
			email: isEmailChannelUsable(user) && isFacetEnabled(user.prefs, "price_targets", "email"),
			sms: isSmsChannelUsable(user) && isFacetEnabled(user.prefs, "price_targets", "sms"),
			telegram: shouldSendTelegram(user, user.prefs, "price_targets"),
		};

		if (!required.email && !required.sms && !required.telegram) {
			await clearTarget(target, "no enabled channels");
			continue;
		}

		const pendingDelivery = target.triggered_at != null && target.triggered_price != null;

		// Backoff: a pending target whose retry window hasn't elapsed waits for a later tick.
		if (
			pendingDelivery &&
			target.next_retry_at != null &&
			new Date(target.next_retry_at).getTime() > Date.now()
		) {
			continue;
		}

		let currentPrice: number;
		let triggeredTarget: TriggeredPriceTarget;

		if (pendingDelivery) {
			currentPrice = target.triggered_price as number;
			triggeredTarget = {
				symbol: target.symbol,
				targetPrice: target.target_price,
				currentPrice,
				direction: target.direction,
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
				direction: target.direction,
				iconUrl: iconUrlMap.get(target.symbol) ?? null,
				iconBase64: iconBase64Map.get(target.symbol) ?? null,
			};

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
		if (required.sms && !smsSender) {
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

		// Channels delivered on a prior retry round are skipped, never re-sent.
		const alreadyDelivered = {
			email: target.email_delivered_at != null,
			sms: target.sms_delivered_at != null,
			telegram: target.telegram_delivered_at != null,
		};

		let outcome: PriceTargetDeliveryOutcome;
		try {
			outcome = await deliverPriceTargetAlert({
				user,
				target: triggeredTarget,
				supabase,
				sendEmail,
				sendSms: smsSender,
				sendTelegram: telegramSender,
				stats: totals,
				logoCache,
				alreadyDelivered,
			});
		} catch (error) {
			rootLogger.error(
				"Failed to deliver price target alert",
				{ userId: target.user_id, symbol: target.symbol },
				error,
			);
			// A thrown delivery is a hard delivery failure, NOT a notification_log
			// write failure — keep logFailures reserved for recordNotification inserts.
			totals.deliveryErrors++;
			// Treat as a fully-failed round so the retry ceiling still applies.
			outcome = { email: "failed", sms: "failed", telegram: "failed" };
		}

		// A required channel is satisfied if it was delivered now or on a prior round.
		const satisfied =
			(!required.email || alreadyDelivered.email || outcome.email === "sent") &&
			(!required.sms || alreadyDelivered.sms || outcome.sms === "sent") &&
			(!required.telegram || alreadyDelivered.telegram || outcome.telegram === "sent");

		if (satisfied) {
			// Every required channel delivered — clear the target (auto-cleared semantics).
			await clearTarget(target, "delivered");
			continue;
		}

		// At least one required channel still failing. Apply the retry ceiling so an
		// undeliverable target stops re-firing every market-minute.
		const newAttemptCount = target.attempt_count + 1;
		if (newAttemptCount >= MAX_PRICE_TARGET_DELIVERY_ATTEMPTS) {
			const unsatisfiedChannels = [
				required.email && !alreadyDelivered.email && outcome.email !== "sent" ? "email" : null,
				required.sms && !alreadyDelivered.sms && outcome.sms !== "sent" ? "sms" : null,
				required.telegram && !alreadyDelivered.telegram && outcome.telegram !== "sent"
					? "telegram"
					: null,
			].filter((c): c is string => c !== null);
			// Terminal delivery failure — clear the target and surface at error so the
			// alarm sees a genuinely undeliverable target.
			rootLogger.error(
				"Price target delivery retries exhausted; clearing target",
				{
					userId: target.user_id,
					symbol: target.symbol,
					unsatisfiedChannels: unsatisfiedChannels.join(","),
					attemptCount: newAttemptCount,
				},
				new Error(`price_target delivery attempt_count >= ${MAX_PRICE_TARGET_DELIVERY_ATTEMPTS}`),
			);
			await clearTarget(target, "retries exhausted");
			continue;
		}

		// Schedule another retry round: record which channels succeeded so they are
		// not re-sent, bump the attempt count, and back off.
		const retryUpdate: {
			attempt_count: number;
			next_retry_at: string;
			email_delivered_at?: string;
			sms_delivered_at?: string;
			telegram_delivered_at?: string;
		} = {
			attempt_count: newAttemptCount,
			// Pass the post-increment count (failures so far) to match the scheduled-notification
			// backoff convention — computeDeliveryRetryDelayMs is 1-based on failures.
			next_retry_at: new Date(
				Date.now() + computeDeliveryRetryDelayMs(newAttemptCount),
			).toISOString(),
		};
		const deliveredAtIso = new Date().toISOString();
		if (outcome.email === "sent") retryUpdate.email_delivered_at = deliveredAtIso;
		if (outcome.sms === "sent") retryUpdate.sms_delivered_at = deliveredAtIso;
		if (outcome.telegram === "sent") retryUpdate.telegram_delivered_at = deliveredAtIso;

		const { error: retryError } = await supabase
			.from("price_targets")
			.update(retryUpdate)
			.eq("user_id", target.user_id)
			.eq("symbol", target.symbol)
			.eq("target_price", target.target_price)
			.eq("direction", target.direction);
		if (retryError) {
			rootLogger.error(
				"Failed to update price target retry state",
				{ userId: target.user_id, symbol: target.symbol },
				retryError,
			);
		}
	}

	return totals;
}
