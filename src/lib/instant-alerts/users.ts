import { rootLogger } from "../logging";
import type { SupabaseAdminClient } from "../schedule/helpers";

const DEFAULT_COOLDOWN_MINUTES = 30;

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
 * Check whether a user is within the cooldown window for a symbol.
 *
 * Returns true if the user should NOT be alerted (cooldown active).
 */
export async function checkCooldown(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<boolean> {
	const cooldownMinutes = getCooldownMinutes();
	const cutoff = new Date(
		Date.now() - cooldownMinutes * 60 * 1000,
	).toISOString();

	const { data, error } = await (supabase
		.from("instant_alert_cooldowns")
		.select("last_alerted_at")
		.eq("user_id", userId)
		.eq("symbol", symbol) as unknown as Promise<{
		data: Array<{ last_alerted_at: string }> | null;
		error: unknown;
	}>);

	if (error) {
		rootLogger.warn("Failed to check cooldown", { userId, symbol }, error);
		return false; // Allow alerting on error (fail open)
	}

	if (!data || data.length === 0) return false;

	return data[0].last_alerted_at > cutoff;
}

/**
 * Upsert the cooldown timestamp for a user+symbol pair.
 */
export async function updateCooldown(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<void> {
	const { error } = await (supabase.from("instant_alert_cooldowns").upsert(
		{
			user_id: userId,
			symbol,
			last_alerted_at: new Date().toISOString(),
		},
		{ onConflict: "user_id,symbol" },
	) as unknown as Promise<{ error: unknown }>);

	if (error) {
		rootLogger.warn("Failed to update cooldown", { userId, symbol }, error);
	}
}
