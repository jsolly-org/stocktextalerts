import type { Logger } from "../logging";
import { sendUserEmail } from "../messaging/email";
import {
	type DelistedHolding,
	formatDelistingEmail,
	summaryText,
} from "../messaging/email/delisting";
import type { EmailSender } from "../messaging/email/utils";
import { deliveryResultToLogFields } from "../messaging/shared";
import {
	fetchTickerReferences,
	type TickerReferenceStatus,
} from "../providers/massive";
import type { SupabaseAdminClient } from "../schedule/helpers";

/** Dependencies injected into `runDelistingSweep`. */
export interface DelistingSweepDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: EmailSender;
	/**
	 * Injection seam for tests — defaults to `fetchTickerReferences` from
	 * the Massive provider. Tests pass a fake that returns pre-canned
	 * statuses without hitting the network.
	 */
	lookupTickerReferences?: (
		symbols: string[],
	) => Promise<TickerReferenceStatus[]>;
}

/** Summary counters returned by `runDelistingSweep`. */
export interface DelistingSweepResult {
	symbolsChecked: number;
	newlyDetectedDelistings: number;
	reprocessedDelistings: number;
	usersNotified: number;
	emailsSkippedOptOut: number;
	emailsFailed: number;
	userAssetRowsDeleted: number;
	priceTargetRowsDeleted: number;
	providerErrors: number;
}

const EMPTY_RESULT: DelistingSweepResult = {
	symbolsChecked: 0,
	newlyDetectedDelistings: 0,
	reprocessedDelistings: 0,
	usersNotified: 0,
	emailsSkippedOptOut: 0,
	emailsFailed: 0,
	userAssetRowsDeleted: 0,
	priceTargetRowsDeleted: 0,
	providerErrors: 0,
};

/**
 * Milliseconds in the notification_log dedupe window. A successful
 * `type='delisting'` row within this window for a given user suppresses a
 * second email, even if the sweep re-runs due to a crash or retry. The
 * window is wider than the cron interval so a crash-across-midnight case
 * can't produce duplicate emails.
 */
const NOTIFICATION_DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Daily delisting sweep. Intended to run inside the AssetEvents Lambda
 * (once per day at 00:00 UTC) in its own try/catch so failures don't
 * invalidate the calendar-events fetch.
 *
 * Flow:
 *   1. Load distinct symbols held by any user.
 *   2. Partition into already-flagged (assets.delisted_at not null) vs
 *      symbols that still need checking.
 *   3. Call Massive reference for the unchecked set.
 *   4. UPDATE assets.delisted_at for newly detected delistings.
 *   5. Build the work set (already-flagged ∪ newly-detected) and find the
 *      users still holding any of those symbols.
 *   6. Skip users already notified within the last 48h (notification_log
 *      dedupe; window wider than the cron interval to cover crash retries).
 *   7. For each affected user:
 *      a. Honor users.email_notifications_enabled — opt-outs get a
 *         notification_log skip row but no email.
 *      b. Otherwise render + send the consolidated delisting email.
 *      c. Record the delivery attempt in notification_log.
 *   8. DELETE price_targets rows for (user, symbol) pairs — must run
 *      before the user_assets delete because price_targets.symbol FKs
 *      into assets(symbol) with CASCADE (not into user_assets).
 *   9. DELETE user_assets rows for the (user, symbol) pairs.
 *
 * If the email send fails OR the notification_log insert fails after a
 * successful send, steps 8–9 are skipped for that user so the next sweep
 * can retry without losing the audit trail that the dedupe check relies on.
 */
export async function runDelistingSweep(
	deps: DelistingSweepDeps,
): Promise<DelistingSweepResult> {
	const { supabase, logger, sendEmail } = deps;
	const lookupTickerReferences =
		deps.lookupTickerReferences ?? fetchTickerReferences;
	const result: DelistingSweepResult = { ...EMPTY_RESULT };

	// 1. Load distinct symbols.
	const { data: trackedRows, error: trackedErr } = await supabase
		.from("user_assets")
		.select("symbol");
	if (trackedErr) {
		logger.error(
			"Delisting sweep failed to load tracked symbols",
			{ action: "delisting_sweep" },
			trackedErr,
		);
		throw trackedErr;
	}
	const symbols = [...new Set((trackedRows ?? []).map((r) => r.symbol))];
	result.symbolsChecked = symbols.length;
	if (symbols.length === 0) return result;

	// 2. Load current assets state for these symbols.
	const { data: assetRows, error: assetsErr } = await supabase
		.from("assets")
		.select("symbol, name, delisted_at")
		.in("symbol", symbols);
	if (assetsErr) {
		logger.error(
			"Delisting sweep failed to load assets metadata",
			{ action: "delisting_sweep", symbolCount: symbols.length },
			assetsErr,
		);
		throw assetsErr;
	}

	interface AssetInfo {
		name: string;
		delistedAt: string; // ISO
		exchange: string | null;
	}
	const workSet = new Map<string, AssetInfo>();
	const symbolsToCheck: string[] = [];
	for (const row of assetRows ?? []) {
		if (row.delisted_at) {
			workSet.set(row.symbol, {
				name: row.name,
				delistedAt: row.delisted_at,
				exchange: null,
			});
			result.reprocessedDelistings += 1;
		} else {
			symbolsToCheck.push(row.symbol);
		}
	}

	// 3. Reference lookup against Massive for unchecked symbols.
	const statuses =
		symbolsToCheck.length > 0
			? await lookupTickerReferences(symbolsToCheck)
			: [];
	const newlyDetected: Array<{
		symbol: string;
		name: string;
		delistedIso: string;
		exchange: string | null;
	}> = [];
	for (const status of statuses) {
		if (status.status === "provider_error") {
			result.providerErrors += 1;
			continue;
		}
		if (status.status !== "delisted") continue;

		const assetRow = (assetRows ?? []).find(
			(r) => r.symbol === status.result.symbol,
		);
		const name = status.result.name ?? assetRow?.name ?? status.result.symbol;
		const delistedIso = `${status.result.delistedUtc}T00:00:00Z`;
		newlyDetected.push({
			symbol: status.result.symbol,
			name,
			delistedIso,
			exchange: status.result.primaryExchange,
		});
	}

	// 4. Persist newly detected delistings to assets.delisted_at.
	for (const entry of newlyDetected) {
		const { error: updateErr } = await supabase
			.from("assets")
			.update({ delisted_at: entry.delistedIso })
			.eq("symbol", entry.symbol)
			.is("delisted_at", null);
		if (updateErr) {
			logger.error(
				"Delisting sweep failed to flag asset",
				{
					action: "delisting_sweep",
					symbol: entry.symbol,
				},
				updateErr,
			);
			continue;
		}
		workSet.set(entry.symbol, {
			name: entry.name,
			delistedAt: entry.delistedIso,
			exchange: entry.exchange,
		});
		result.newlyDetectedDelistings += 1;
	}

	if (workSet.size === 0) return result;

	// 5. Find affected users.
	const workSetSymbols = [...workSet.keys()];
	const { data: affectedRows, error: affectedErr } = await supabase
		.from("user_assets")
		.select("user_id, symbol")
		.in("symbol", workSetSymbols);
	if (affectedErr) {
		logger.error(
			"Delisting sweep failed to load affected users",
			{ action: "delisting_sweep" },
			affectedErr,
		);
		throw affectedErr;
	}
	if ((affectedRows ?? []).length === 0) return result;

	const userHoldings = new Map<string, DelistedHolding[]>();
	for (const row of affectedRows ?? []) {
		const info = workSet.get(row.symbol);
		if (!info) continue;
		const holdings = userHoldings.get(row.user_id) ?? [];
		holdings.push({
			symbol: row.symbol,
			name: info.name,
			delistedDate: info.delistedAt.slice(0, 10),
			exchange: info.exchange,
		});
		userHoldings.set(row.user_id, holdings);
	}
	const affectedUserIds = [...userHoldings.keys()];

	// 6. Load recipient info.
	const { data: userRows, error: usersErr } = await supabase
		.from("users")
		.select("id, email, email_notifications_enabled")
		.in("id", affectedUserIds);
	if (usersErr) {
		logger.error(
			"Delisting sweep failed to load affected users' recipient info",
			{ action: "delisting_sweep" },
			usersErr,
		);
		throw usersErr;
	}
	const userInfo = new Map<
		string,
		{ id: string; email: string; emailNotificationsEnabled: boolean }
	>();
	for (const u of userRows ?? []) {
		userInfo.set(u.id, {
			id: u.id,
			email: u.email,
			emailNotificationsEnabled: u.email_notifications_enabled,
		});
	}

	// 7. 48h notification_log dedupe.
	const cutoff = new Date(
		Date.now() - NOTIFICATION_DEDUPE_WINDOW_MS,
	).toISOString();
	const { data: recentNotes, error: recentErr } = await supabase
		.from("notification_log")
		.select("user_id")
		.eq("type", "delisting")
		.eq("message_delivered", true)
		.gte("created_at", cutoff)
		.in("user_id", affectedUserIds);
	if (recentErr) {
		logger.error(
			"Delisting sweep failed to load recent notification_log for dedupe",
			{ action: "delisting_sweep" },
			recentErr,
		);
		throw recentErr;
	}
	const alreadyNotified = new Set((recentNotes ?? []).map((r) => r.user_id));

	// 8. Process each affected user sequentially.
	for (const [userId, holdings] of userHoldings) {
		const user = userInfo.get(userId);
		if (!user) {
			logger.warn("Delisting sweep: affected user not found in users table", {
				action: "delisting_sweep",
				userId,
			});
			continue;
		}

		let shouldRunCleanup = true;
		const sortedHoldings = [...holdings].sort((a, b) =>
			a.symbol.localeCompare(b.symbol),
		);
		const summary = summaryText(sortedHoldings);

		if (!user.emailNotificationsEnabled) {
			// Opt-out: no email, still clean up. Log the skip so the audit trail
			// shows why no email went out.
			const { error: optOutLogErr } = await supabase
				.from("notification_log")
				.insert({
					user_id: userId,
					type: "delisting",
					delivery_method: "email",
					message_delivered: false,
					message: summary,
					error: "email_notifications_disabled",
					error_code: null,
				});
			if (optOutLogErr) {
				logger.error(
					"Delisting sweep failed to record opt-out notification_log entry",
					{ action: "delisting_sweep", userId },
					optOutLogErr,
				);
				// Skip cleanup so the next sweep can retry the audit trail —
				// losing the log row while deleting user_assets would break the
				// 48h dedupe check on retry and could send duplicate emails.
				shouldRunCleanup = false;
			}
			result.emailsSkippedOptOut += 1;
		} else if (alreadyNotified.has(userId)) {
			// Already notified within the dedupe window — don't resend, but still
			// run cleanup in case a previous sweep emailed but crashed before
			// deleting.
		} else {
			const { subject, text, html } = formatDelistingEmail(
				{ id: user.id, email: user.email },
				sortedHoldings,
			);
			const deliveryResult = await sendUserEmail(
				{ id: user.id, email: user.email },
				subject,
				{ text, html },
				sendEmail,
			);

			const { error: logErr } = await supabase.from("notification_log").insert({
				user_id: userId,
				type: "delisting",
				delivery_method: "email",
				message_delivered: deliveryResult.success,
				message: summary,
				...deliveryResultToLogFields(deliveryResult),
			});
			if (logErr) {
				logger.error(
					"Delisting sweep failed to record notification_log entry",
					{
						action: "delisting_sweep",
						userId,
						delivered: deliveryResult.success,
					},
					logErr,
				);
				// Critical: if we sent the email but couldn't record the log row,
				// skip cleanup so the dedupe check on retry can fire. Sending a
				// duplicate delete attempt is cheaper than sending a duplicate
				// delisting email to the user.
				if (deliveryResult.success) {
					shouldRunCleanup = false;
				}
			}

			if (!deliveryResult.success) {
				result.emailsFailed += 1;
				// Leave user_assets / price_targets intact so the next sweep retries.
				shouldRunCleanup = false;
			} else {
				result.usersNotified += 1;
			}
		}

		if (!shouldRunCleanup) continue;

		// 9. Delete price_targets first — the FK on price_targets.symbol cascades
		// from assets(symbol), NOT from user_assets, so deleting user_assets alone
		// would leave orphaned rows pointing at a delisted symbol whose asset row
		// is still present.
		const symbolsForUser = sortedHoldings.map((h) => h.symbol);

		const { error: ptErr, count: ptCount } = await supabase
			.from("price_targets")
			.delete({ count: "exact" })
			.eq("user_id", userId)
			.in("symbol", symbolsForUser);
		if (ptErr) {
			logger.error(
				"Delisting sweep failed to delete price_targets",
				{ action: "delisting_sweep", userId, symbols: symbolsForUser },
				ptErr,
			);
			continue;
		}
		result.priceTargetRowsDeleted += ptCount ?? 0;

		const { error: uaErr, count: uaCount } = await supabase
			.from("user_assets")
			.delete({ count: "exact" })
			.eq("user_id", userId)
			.in("symbol", symbolsForUser);
		if (uaErr) {
			logger.error(
				"Delisting sweep failed to delete user_assets",
				{ action: "delisting_sweep", userId, symbols: symbolsForUser },
				uaErr,
			);
			continue;
		}
		result.userAssetRowsDeleted += uaCount ?? 0;
	}

	return result;
}
