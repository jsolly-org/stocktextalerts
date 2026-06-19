/** Minimal user fields needed to decide Telegram deliverability. */
interface TelegramEligibilityUser {
	telegram_chat_id: number | null;
	telegram_opted_out: boolean;
}

/** A telegram preference row (subset of notification_preferences). */
export interface TelegramPrefRow {
	notification_type: string;
	content: string;
	enabled: boolean;
}

/**
 * True when the user can receive Telegram messages at all: a chat is linked and
 * they haven't been opted out (set only by a verified outbound 403 — "bot blocked").
 * The Telegram analog of `isSmsChannelUsable` (linked + not opted out), independent
 * of any per-option preference.
 */
export function isTelegramChannelUsable(user: TelegramEligibilityUser): boolean {
	return user.telegram_chat_id != null && !user.telegram_opted_out;
}

/**
 * The set of content facets enabled for Telegram for a given notification type
 * (e.g. {"prices","top_movers"} for daily_digest). Facet-less types use "".
 */
export function enabledTelegramFacets(
	prefs: TelegramPrefRow[],
	notificationType: string,
): Set<string> {
	const facets = new Set<string>();
	for (const p of prefs) {
		if (p.notification_type === notificationType && p.enabled) {
			facets.add(p.content);
		}
	}
	return facets;
}

/**
 * True when the user should receive a Telegram notification of this type:
 * the channel is usable AND at least one content facet is enabled for it.
 * Mirrors the shape of `shouldSendSms`, but reads preferences from
 * notification_preferences rows rather than per-column user flags.
 */
export function shouldSendTelegram(
	user: TelegramEligibilityUser,
	prefs: TelegramPrefRow[],
	notificationType: string,
): boolean {
	return isTelegramChannelUsable(user) && enabledTelegramFacets(prefs, notificationType).size > 0;
}
