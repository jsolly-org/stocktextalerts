import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { sendUserEmail } from "../messaging/email";
import {
	type DelistedHolding,
	formatDelistingEmail,
	summaryText,
} from "../messaging/email/delisting";
import type { EmailSender } from "../messaging/email/utils";
import { deliveryResultToLogFields } from "../messaging/shared";
import { isSmsChannelUsable, sendUserSms } from "../messaging/sms";
import { formatDelistingSms } from "../messaging/sms/delisting";
import type { SmsSenderFactory } from "../messaging/sms/sender-factory";
import { fetchTickerReferences } from "./reference/delistings";

/** Dependencies for `runDelistingSweep`. */
interface DelistingSweepDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
}

/** Summary counters returned by `runDelistingSweep`. */
interface DelistingSweepResult {
	symbolsChecked: number;
	newlyDetectedDelistings: number;
	reprocessedDelistings: number;
	/** Users who received at least one successful delivery on any channel. */
	usersNotified: number;
	emailsDelivered: number;
	emailsSkippedOptOut: number;
	emailsFailed: number;
	smsDelivered: number;
	smsSkippedOptOut: number;
	smsFailed: number;
	userAssetRowsDeleted: number;
	priceTargetRowsDeleted: number;
	providerErrors: number;
}

const EMPTY_RESULT: DelistingSweepResult = {
	symbolsChecked: 0,
	newlyDetectedDelistings: 0,
	reprocessedDelistings: 0,
	usersNotified: 0,
	emailsDelivered: 0,
	emailsSkippedOptOut: 0,
	emailsFailed: 0,
	smsDelivered: 0,
	smsSkippedOptOut: 0,
	smsFailed: 0,
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
 * Daily delisting sweep. Intended to run inside the AssetMaintenance Lambda
 * (once per day at 00:00 UTC) in its own try/catch so failures don't
 * invalidate the calendar-events fetch.
 *
 * Multi-channel: every enabled channel (email, SMS) receives an independent
 * copy of the delisting notice. This matches the pattern used by
 * daily-digest / asset-events / market-notifications — users get notified
 * on whatever channels they have turned on, not on a single "preferred"
 * channel with the other as a fallback.
 *
 * Flow:
 *   1. Load distinct symbols held by any user.
 *   2. Partition into already-flagged (assets.delisted_at not null) vs
 *      symbols that still need checking.
 *   3. Call Massive reference for the unchecked set.
 *   4. UPDATE assets.delisted_at for newly detected delistings.
 *   5. Build the work set (already-flagged ∪ newly-detected) and find the
 *      users still holding any of those symbols.
 *   6. Load recipient info: email + SMS eligibility fields.
 *   7. Per-channel 48h notification_log dedupe — a delivered=true row on
 *      channel X in the window suppresses re-send on channel X only.
 *   8. For each affected user, attempt every enabled channel independently:
 *      a. Email: send if enabled + not deduped, otherwise log opt-out row.
 *      b. SMS: send if `isSmsChannelUsable()` + not deduped, otherwise log
 *         opt-out row with error="sms_not_usable".
 *      c. Record each attempt in notification_log.
 *   9. Cleanup gate: if any channel had a transient failure (send or log
 *      insert), skip steps 10–11 so the next sweep retries. Opt-out rows
 *      and dedupe-skips are cleanup-safe.
 *  10. DELETE price_targets rows for (user, symbol) pairs — must run
 *      before the user_assets delete because price_targets.symbol FKs
 *      into assets(symbol) with CASCADE (not into user_assets).
 *  11. DELETE user_assets rows for the (user, symbol) pairs.
 *
 * Users with NO enabled channels (both email and SMS opted out / not
 * usable) still get cleanup — their data is removed silently and the
 * notification_log records why no outbound message went out.
 */
export async function runDelistingSweep(deps: DelistingSweepDeps): Promise<DelistingSweepResult> {
	const { supabase, logger, sendEmail, getSmsSender } = deps;
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
	const statuses = symbolsToCheck.length > 0 ? await fetchTickerReferences(symbolsToCheck) : [];
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

		const assetRow = (assetRows ?? []).find((r) => r.symbol === status.result.symbol);
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

	// 6. Load recipient info (includes SMS eligibility fields).
	const { data: userRows, error: usersErr } = await supabase
		.from("users")
		.select(
			"id, email, email_notifications_enabled, sms_notifications_enabled, sms_opted_out, phone_country_code, phone_number, phone_verified",
		)
		.in("id", affectedUserIds);
	if (usersErr) {
		logger.error(
			"Delisting sweep failed to load affected users' recipient info",
			{ action: "delisting_sweep" },
			usersErr,
		);
		throw usersErr;
	}

	interface AffectedUser {
		id: string;
		email: string;
		emailNotificationsEnabled: boolean;
		smsNotificationsEnabled: boolean;
		smsOptedOut: boolean;
		phoneCountryCode: string | null;
		phoneNumber: string | null;
		phoneVerified: boolean;
	}
	const userInfo = new Map<string, AffectedUser>();
	for (const u of userRows ?? []) {
		userInfo.set(u.id, {
			id: u.id,
			email: u.email,
			emailNotificationsEnabled: u.email_notifications_enabled,
			smsNotificationsEnabled: u.sms_notifications_enabled,
			smsOptedOut: u.sms_opted_out,
			phoneCountryCode: u.phone_country_code,
			phoneNumber: u.phone_number,
			phoneVerified: u.phone_verified,
		});
	}

	// 7. Per-channel 48h notification_log dedupe.
	// A successful delivered=true row on channel X within the dedupe window
	// suppresses re-sending on channel X only, so a user who got email yesterday
	// but had SMS flake today will get only the SMS retry tomorrow.
	const cutoff = new Date(Date.now() - NOTIFICATION_DEDUPE_WINDOW_MS).toISOString();
	const { data: recentNotes, error: recentErr } = await supabase
		.from("notification_log")
		.select("user_id, delivery_method")
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
	const emailDeduped = new Set<string>();
	const smsDeduped = new Set<string>();
	for (const row of recentNotes ?? []) {
		if (row.delivery_method === "email") emailDeduped.add(row.user_id);
		else if (row.delivery_method === "sms") smsDeduped.add(row.user_id);
	}

	// 8. Process each affected user: attempt every enabled channel independently.
	for (const [userId, holdings] of userHoldings) {
		const user = userInfo.get(userId);
		if (!user) {
			logger.error("Delisting sweep: affected user not found in users table", {
				action: "delisting_sweep",
				userId,
			});
			continue;
		}

		const sortedHoldings = [...holdings].sort((a, b) => a.symbol.localeCompare(b.symbol));
		const summary = summaryText(sortedHoldings);

		// Per-user per-channel outcome tracking. A channel blocks cleanup only
		// when its delivery_result.success is false OR its log insert failed
		// after a successful send (so the dedupe trail stays intact on retry).
		let hasTransientFailure = false;
		let deliveredOnAnyChannel = false;

		// --- Email channel ---
		if (!user.emailNotificationsEnabled) {
			const { error: optOutLogErr } = await supabase.from("notification_log").insert({
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
					"Delisting sweep failed to record email opt-out notification_log",
					{ action: "delisting_sweep", userId },
					optOutLogErr,
				);
				hasTransientFailure = true;
			}
			result.emailsSkippedOptOut += 1;
		} else if (!emailDeduped.has(userId)) {
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
					"Delisting sweep failed to record email notification_log",
					{
						action: "delisting_sweep",
						userId,
						delivered: deliveryResult.success,
					},
					logErr,
				);
				// If we sent the email but couldn't record the log row, skip
				// cleanup so the dedupe check on retry can fire. Duplicate
				// delete attempts are cheaper than duplicate emails.
				if (deliveryResult.success) hasTransientFailure = true;
			}

			if (deliveryResult.success) {
				result.emailsDelivered += 1;
				deliveredOnAnyChannel = true;
			} else {
				result.emailsFailed += 1;
				hasTransientFailure = true;
			}
		}
		// Else: dedupe skip — silent pass, cleanup-safe.

		// --- SMS channel ---
		const smsEligibility = {
			sms_opted_out: user.smsOptedOut,
			sms_notifications_enabled: user.smsNotificationsEnabled,
			phone_verified: user.phoneVerified,
			phone_country_code: user.phoneCountryCode,
			phone_number: user.phoneNumber,
		};
		if (!isSmsChannelUsable(smsEligibility)) {
			const { error: optOutLogErr } = await supabase.from("notification_log").insert({
				user_id: userId,
				type: "delisting",
				delivery_method: "sms",
				message_delivered: false,
				message: summary,
				error: "sms_not_usable",
				error_code: null,
			});
			if (optOutLogErr) {
				logger.error(
					"Delisting sweep failed to record SMS opt-out notification_log",
					{ action: "delisting_sweep", userId },
					optOutLogErr,
				);
				hasTransientFailure = true;
			}
			result.smsSkippedOptOut += 1;
		} else if (!smsDeduped.has(userId)) {
			const smsMessage = formatDelistingSms(sortedHoldings);
			const smsSender = getSmsSender().sender;
			const deliveryResult = await sendUserSms(
				{
					id: user.id,
					phone_country_code: user.phoneCountryCode,
					phone_number: user.phoneNumber,
				},
				smsMessage,
				smsSender,
				supabase,
			);

			const { error: logErr } = await supabase.from("notification_log").insert({
				user_id: userId,
				type: "delisting",
				delivery_method: "sms",
				message_delivered: deliveryResult.success,
				message: summary,
				...deliveryResultToLogFields(deliveryResult),
			});
			if (logErr) {
				logger.error(
					"Delisting sweep failed to record SMS notification_log",
					{
						action: "delisting_sweep",
						userId,
						delivered: deliveryResult.success,
					},
					logErr,
				);
				if (deliveryResult.success) hasTransientFailure = true;
			}

			if (deliveryResult.success) {
				result.smsDelivered += 1;
				deliveredOnAnyChannel = true;
			} else {
				result.smsFailed += 1;
				hasTransientFailure = true;
			}
		}
		// Else: dedupe skip — silent pass, cleanup-safe.

		if (deliveredOnAnyChannel) result.usersNotified += 1;

		if (hasTransientFailure) continue;

		// 9. Cleanup — delete price_targets first because price_targets.symbol
		// FKs into assets(symbol) with CASCADE, NOT user_assets. Deleting
		// user_assets alone leaves orphaned price_targets rows pointing at a
		// delisted symbol whose asset row is still present.
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
