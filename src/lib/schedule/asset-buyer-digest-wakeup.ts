import type { DateTime } from "luxon";
import { US_BEFORE_OPEN_EASTERN_MINUTES, US_MARKET_TIMEZONE } from "../constants";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { wakeupAssetBuyerFromDailyDigest } from "../market-notifications/flat-alerts/asset-buyer-wakeup";
import { minuteOfDayFromDateTime } from "../time/utils";
import type { MarketSession } from "../types";

/** Inclusive 09:00 ET through exclusive 09:30 ET (premarket until cash open). */
const DIGEST_WAKE_WINDOW_END_EASTERN_MINUTES = 9 * 60 + 30;

export type DigestWakeResult = "invoked" | "skipped";

function isDigestWakeWindow(now: DateTime): boolean {
	const eastern = now.setZone(US_MARKET_TIMEZONE);
	if (!eastern.isValid) return false;
	const minutes = minuteOfDayFromDateTime(eastern);
	return (
		minutes >= US_BEFORE_OPEN_EASTERN_MINUTES && minutes < DIGEST_WAKE_WINDOW_END_EASTERN_MINUTES
	);
}

/**
 * Once per US session day, async-invoke asset-buyer with `sta_daily_digest`.
 * Not gated on any user's Daily Notification master toggle. Fail-open.
 */
export async function maybeWakeAssetBuyerFromDailyDigest(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	now: DateTime;
	equitySession: MarketSession;
	wakeup?: typeof wakeupAssetBuyerFromDailyDigest;
}): Promise<DigestWakeResult> {
	const {
		supabase,
		logger,
		now,
		equitySession,
		wakeup = wakeupAssetBuyerFromDailyDigest,
	} = options;

	if (!isDigestWakeWindow(now)) {
		return "skipped";
	}
	if (equitySession === "closed") {
		return "skipped";
	}

	const etDate = now.setZone(US_MARKET_TIMEZONE).toISODate();
	if (!etDate) {
		return "skipped";
	}

	let claimed = false;
	try {
		const { data, error } = await supabase.rpc("claim_asset_buyer_digest_wake", {
			p_et_date: etDate,
		});
		if (error) {
			logger.warn(
				"Asset-buyer daily digest wake claim failed (fail-open)",
				{ action: "sta_daily_digest", etDate },
				error,
			);
			return "skipped";
		}
		claimed = data === true;
	} catch (error) {
		logger.warn(
			"Asset-buyer daily digest wake claim failed (fail-open)",
			{ action: "sta_daily_digest", etDate },
			error,
		);
		return "skipped";
	}

	if (!claimed) {
		return "skipped";
	}

	let woke = false;
	let loggedInvokeFailure = false;
	try {
		woke = await wakeup();
	} catch (error) {
		loggedInvokeFailure = true;
		logger.warn(
			"Asset-buyer daily digest wakeup invoke failed after claim (fail-open)",
			{ action: "sta_daily_digest", etDate },
			error,
		);
	}
	if (woke) {
		logger.info("Asset-buyer daily digest wakeup claimed", { action: "sta_daily_digest", etDate });
		return "invoked";
	}

	try {
		const { error } = await supabase.rpc("release_asset_buyer_digest_wake", {
			p_et_date: etDate,
		});
		if (error) {
			logger.warn(
				"Asset-buyer daily digest wake release failed (fail-open)",
				{ action: "sta_daily_digest", etDate },
				error,
			);
		}
	} catch (error) {
		logger.warn(
			"Asset-buyer daily digest wake release failed (fail-open)",
			{ action: "sta_daily_digest", etDate },
			error,
		);
	}
	if (!loggedInvokeFailure) {
		logger.warn(
			"Asset-buyer daily digest wakeup invoke failed after claim (fail-open)",
			{ action: "sta_daily_digest", etDate },
			new Error("heartbeat invoke returned false"),
		);
	}
	return "skipped";
}
