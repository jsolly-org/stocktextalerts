import {
	type AssetEventsContent,
	anyFacetEnabled,
	type DailyDigestContent,
	enabledFacets,
	type FacetlessContent,
	type NotificationPreferenceType,
	type PrefRow,
} from "../notification-prefs";

/** Minimal user fields needed to decide Telegram deliverability. */
interface TelegramEligibilityUser {
	telegram_chat_id: number | null;
	telegram_opted_out: boolean;
}

/** A telegram preference row (kept for back-compat with call sites). */
export type TelegramPrefRow = PrefRow;

/**
 * True when the user can receive Telegram messages at all: a chat is linked and
 * they haven't been opted out (set only by a verified outbound 403 — "bot blocked").
 * The Telegram analog of `isSmsChannelUsable` (linked + not opted out), independent
 * of any per-option preference.
 *
 * `telegram_opted_out` is the SOLE channel-disable signal — there is no
 * `telegram_notifications_enabled` peer to SMS's two-flag model (see opt-out.ts).
 * Every send path must funnel through this helper (or `shouldSendTelegram`).
 */
export function isTelegramChannelUsable(user: TelegramEligibilityUser): boolean {
	return user.telegram_chat_id != null && !user.telegram_opted_out;
}

/**
 * The set of content facets enabled for Telegram for a given notification type
 * (e.g. {"prices","top_movers"} for daily_digest). Facet-less types use "".
 */
export function enabledTelegramFacets(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
): Set<DailyDigestContent | AssetEventsContent | FacetlessContent> {
	return enabledFacets(prefs, notificationType, "telegram");
}

/**
 * True when the user should receive a Telegram notification of this type:
 * the channel is usable AND at least one content facet is enabled for it.
 */
export function shouldSendTelegram(
	user: TelegramEligibilityUser,
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
): boolean {
	return isTelegramChannelUsable(user) && anyFacetEnabled(prefs, notificationType, "telegram");
}
