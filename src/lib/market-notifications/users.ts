import { rootLogger } from "../logging";
import type { SupabaseAdminClient } from "../schedule/helpers";
import type {
	AlertFollowUpMode,
	AlertMarketContext,
	AlertMoveSize,
	AlertRiskPriority,
} from "./alert-profile";

export interface PriceAlertUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	market_asset_price_alerts_include_email: boolean;
	market_asset_price_alerts_include_sms: boolean;
	market_asset_price_alert_risk_priority: AlertRiskPriority;
	market_asset_price_alert_market_context: AlertMarketContext;
	market_asset_price_alert_move_size: AlertMoveSize;
	market_asset_price_alert_follow_up_mode: AlertFollowUpMode;
}

/**
 * Fetch users who have price alerts enabled and at least one delivery channel
 * (email or SMS). Used by the price-alert pipeline to determine recipients.
 */
export async function fetchPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<PriceAlertUser[]> {
	const { data, error } = await (supabase
		.from("users")
		.select(
			"id, email, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, market_asset_price_alerts_include_email, market_asset_price_alerts_include_sms, market_asset_price_alert_risk_priority, market_asset_price_alert_market_context, market_asset_price_alert_move_size, market_asset_price_alert_follow_up_mode",
		)
		.eq("market_asset_price_alerts_enabled", true)
		.or(
			"market_asset_price_alerts_include_email.eq.true,market_asset_price_alerts_include_sms.eq.true",
		) as unknown as Promise<{
		data: PriceAlertUser[] | null;
		error: unknown;
	}>);

	if (error) {
		rootLogger.error(
			"Failed to fetch price alert users",
			{ action: "fetch_price_alert_users" },
			error,
		);
		return [];
	}

	return data ?? [];
}

/**
 * Atomically claim per-symbol eligibility for the current US trading day via
 * `claim_market_asset_price_alert_slot` (single RPC with INSERT ... ON CONFLICT
 * DO UPDATE). Prevents duplicate alerts when overlapping cron ticks or retries
 * race.
 *
 * @returns true when alert delivery should proceed; false when already sent today
 *   or slot is denied by follow-up rules (acceleration/recovery).
 */
export async function claimCooldown(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
	absMovePercent: number,
	absMoveDollar: number,
	allowAccelerationFollowUp: boolean,
	allowRecoveryFollowUp = false,
	moveDirection: "up" | "down" | null = null,
): Promise<boolean> {
	const { data: claimed, error } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_market_asset_price_alert_slot", {
		p_user_id: userId,
		p_symbol: symbol,
		p_abs_move_percent: absMovePercent,
		p_abs_move_dollar: absMoveDollar,
		p_allow_acceleration_follow_up: allowAccelerationFollowUp,
		p_allow_recovery_follow_up: allowRecoveryFollowUp,
		p_move_direction: moveDirection,
	});

	if (error) {
		rootLogger.warn(
			"Failed to claim price alert trading-day cap",
			{ userId, symbol },
			error,
		);
		return true; // Allow alerting on error (fail open)
	}

	return Boolean(claimed);
}
