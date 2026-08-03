import type { DeliveryChannelMode, DeliveryMethod } from "../constants";
import type { AppSupabaseClient } from "../db/supabase";
import type { UserUpdateInput } from "../db/types";

/** Minimal user fields for account delivery routing. */
export interface DeliveryChannelUser {
	delivery_channel: DeliveryChannelMode;
	telegram_chat_id: number | null;
}

/**
 * PostgREST `.or()` filter: account has an active delivery pipe
 * (`email` or `telegram`). Shared by daily + market-scheduled candidate queries.
 */
export const HAS_ACTIVE_DELIVERY_OR = "delivery_channel.in.(email,telegram)";

/** True when the account is routed to email. */
export function wantsEmailDelivery(user: Pick<DeliveryChannelUser, "delivery_channel">): boolean {
	return user.delivery_channel === "email";
}

/**
 * True when the account is routed to Telegram AND a chat is linked.
 * A telegram routing with no chat_id is non-deliverable (should not be selectable in UI).
 */
export function wantsTelegramDelivery(user: DeliveryChannelUser): boolean {
	return user.delivery_channel === "telegram" && user.telegram_chat_id != null;
}

/**
 * Resolve the single outbound pipe for this account, or null when nothing
 * should send (Disabled, or Telegram selected without a linked chat).
 */
export function resolveOutboundChannel(user: DeliveryChannelUser): DeliveryMethod | null {
	if (wantsEmailDelivery(user)) return "email";
	if (wantsTelegramDelivery(user)) return "telegram";
	return null;
}

/**
 * True when the dashboard should show "pick a delivery channel".
 * Disabled means no active pipe.
 */
export function needsNotificationChannelSelection(
	user: Pick<DeliveryChannelUser, "delivery_channel">,
): boolean {
	return user.delivery_channel === "disabled";
}

/** Legacy flag twin of `delivery_channel` (expand-era columns). */
export type LegacyDeliveryFlags = {
	email_notifications_enabled: boolean;
	telegram_opted_out: boolean;
};

/**
 * Inverse of the expand backfill/trigger CASE so old Lambdas mute correctly
 * while `delivery_channel` is the authored routing source.
 */
export function legacyFlagsForDeliveryChannel(channel: DeliveryChannelMode): LegacyDeliveryFlags {
	switch (channel) {
		case "telegram":
			return { email_notifications_enabled: false, telegram_opted_out: false };
		case "email":
			return { email_notifications_enabled: true, telegram_opted_out: true };
		case "disabled":
			return { email_notifications_enabled: false, telegram_opted_out: true };
	}
}

function isUndefinedColumnError(error: { message?: string; code?: string }): boolean {
	const msg = error.message ?? "";
	return (
		error.code === "PGRST204" ||
		/could not find.*column/i.test(msg) ||
		/column .* does not exist/i.test(msg)
	);
}

/**
 * Update `users.delivery_channel`, dual-writing expand-era legacy flags when
 * those columns still exist (Vercel-ahead-of-Deploy / expand bake window).
 * Retries without legacy columns after contract migrate drops them.
 */
export async function updateUserDeliveryChannel(options: {
	supabase: AppSupabaseClient;
	userId: string;
	channel: DeliveryChannelMode;
	/** CAS: only update when current delivery_channel matches. */
	casCurrent?: DeliveryChannelMode;
	/** Extra user columns (e.g. clear telegram link on /unlink). */
	extra?: UserUpdateInput;
}): Promise<{ updated: boolean; error: { message: string; code?: string } | null }> {
	const { supabase, userId, channel, casCurrent, extra } = options;
	const withLegacy = {
		...extra,
		delivery_channel: channel,
		...legacyFlagsForDeliveryChannel(channel),
	} as UserUpdateInput;

	const run = async (patch: UserUpdateInput) => {
		let query = supabase.from("users").update(patch).eq("id", userId);
		if (casCurrent !== undefined) {
			query = query.eq("delivery_channel", casCurrent);
		}
		return query.select("id").maybeSingle();
	};

	let { data, error } = await run(withLegacy);
	if (error && isUndefinedColumnError(error)) {
		const withoutLegacy = { ...extra, delivery_channel: channel } as UserUpdateInput;
		({ data, error } = await run(withoutLegacy));
	}

	return {
		updated: data != null,
		error: error ? { message: error.message, code: error.code } : null,
	};
}
