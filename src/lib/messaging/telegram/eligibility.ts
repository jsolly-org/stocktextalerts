import type { NotificationPreferenceType } from "../../constants";
import type { PrefRow } from "../../types";
import { anyFacetEnabled } from "../notification-prefs";

/** Minimal user fields needed to decide Telegram deliverability. */
export interface TelegramEligibilityUser {
	telegram_chat_id: number | null;
	telegram_opted_out: boolean;
}

/**
 * True when the user can receive Telegram messages at all: a chat is linked and
 * they haven't been opted out (dashboard global toggle, `/stop`, or a verified
 * outbound 403 — "bot blocked"). Independent of any per-option preference.
 *
 * `telegram_opted_out` is the SOLE channel-disable signal — there is no
 * `telegram_notifications_enabled` peer column (the form field of that name is
 * positive UI polarity that inverts to this flag; see update-payload.ts).
 * Every send path must funnel through this helper (or `shouldSendTelegram`).
 */
export function isTelegramChannelUsable(user: TelegramEligibilityUser): boolean {
	return user.telegram_chat_id != null && !user.telegram_opted_out;
}

/** Positive UI/API polarity for the global Telegram toggle (`!telegram_opted_out`). */
export function toTelegramNotificationsEnabled(telegramOptedOut: boolean): boolean {
	return !telegramOptedOut;
}

/** Persist positive form polarity back to `users.telegram_opted_out`. */
export function toTelegramOptedOut(telegramNotificationsEnabled: boolean): boolean {
	return !telegramNotificationsEnabled;
}

/**
 * True when the dashboard should show "Enable at least one notification channel".
 * Global email on OR a usable Telegram link counts as a configured channel.
 */
export function needsNotificationChannelSelection(
	emailEnabled: boolean,
	telegram: TelegramEligibilityUser,
): boolean {
	return !emailEnabled && !isTelegramChannelUsable(telegram);
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
