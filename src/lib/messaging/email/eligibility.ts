/** Minimal user fields needed to decide email deliverability. */
interface EmailEligibilityUser {
	/** Global per-user email kill-switch. The email analog of
	 *  `sms_notifications_enabled` / the Telegram opt-out flag. */
	email_notifications_enabled: boolean;
}

/**
 * True when the user can receive notification emails at all: the global
 * `email_notifications_enabled` kill-switch is on. The email analog of
 * `isSmsChannelUsable` / `isTelegramChannelUsable`, independent of any
 * per-option facet.
 *
 * Every notification type that sends email MUST AND this with the per-option
 * facet (`isFacetEnabled(prefs, type, "email")`). The per-option facets are
 * contractually gated on this flag (see the `*_include_email` column comments
 * migrated into `notification_preferences`), but `isFacetEnabled` inspects only
 * pref rows, so the global gate has to be applied at the call site.
 */
export function isEmailChannelUsable(user: EmailEligibilityUser): boolean {
	return user.email_notifications_enabled;
}
