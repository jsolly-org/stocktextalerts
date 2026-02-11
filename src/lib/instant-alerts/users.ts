import { rootLogger } from "../logging";
import type { SupabaseAdminClient } from "../schedule/helpers";

const DEFAULT_COOLDOWN_MINUTES = 30;

/**
 * Read the cooldown duration (minutes) from env, falling back to a safe default.
 *
 * This controls how frequently a user can receive instant alerts per symbol.
 */
function getCooldownMinutes(): number {
	const raw = process.env.INSTANT_ALERT_COOLDOWN_MINUTES;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_COOLDOWN_MINUTES;
}

export interface InstantAlertUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	instant_include_email: boolean;
	instant_include_sms: boolean;
	instant_alert_sensitivity: number;
}

/**
 * Fetch users who have instant alerts enabled with at least one delivery channel.
 */
export async function fetchInstantAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<InstantAlertUser[]> {
	const { data, error } = await (supabase
		.from("users")
		.select(
			"id, email, phone_country_code, phone_number, instant_include_email, instant_include_sms, instant_alert_sensitivity",
		)
		.eq("instant_notifications_enabled", true)
		.or(
			"instant_include_email.eq.true,instant_include_sms.eq.true",
		) as unknown as Promise<{
		data: InstantAlertUser[] | null;
		error: unknown;
	}>);

	if (error) {
		rootLogger.error(
			"Failed to fetch instant alert users",
			{ action: "fetch_instant_alert_users" },
			error,
		);
		return [];
	}

	return data ?? [];
}

/**
 * Atomically claim a cooldown slot for a user+symbol pair.
 *
 * Returns true when alert delivery should proceed, false when still on cooldown.
 */
export async function claimCooldown(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<boolean> {
	const cooldownMinutes = getCooldownMinutes();
	const { data: claimed, error } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_instant_alert_cooldown", {
		p_user_id: userId,
		p_symbol: symbol,
		p_cooldown_minutes: cooldownMinutes,
	});

	if (error) {
		rootLogger.warn(
			"Failed to claim instant alert cooldown",
			{ userId, symbol },
			error,
		);
		return true; // Allow alerting on error (fail open)
	}

	return Boolean(claimed);
}
