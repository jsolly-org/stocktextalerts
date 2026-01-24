import { MAX_TRACKED_STOCKS } from "./db/database-errors";
import { rootLogger } from "./logging";

const MESSAGE_ALLOWLIST = {
	stock_added: "Stock added successfully",
	stock_removed: "Stock removed successfully",
	stocks_updated: "Tracked stocks updated successfully",
	phone_verified: "Phone number verified successfully",
	settings_updated: "Settings updated successfully",
	timezone_updated: "Timezone updated successfully",
	timezone_banner_dismissed: "Timezone banner dismissed",
	invalid_form:
		"There was a problem with your submission. Please check the form and try again.",
	verification_sent: "Verification code sent",
	verification_failed: "Failed to send verification code",
	failed_to_add_stock: "Failed to add stock",
	failed_to_remove_stock: "Failed to remove stock",
	failed_to_update_stocks: "Failed to update tracked stocks. Please try again.",
	server_error: "An error occurred. Please try again",
	phone_not_set: "Phone number not set",
	sms_opted_out: "SMS notifications are disabled for this number",
	sms_notifications_disabled: "SMS notifications are disabled.",
	notifications_not_configured:
		"Enable at least one notification channel to send a daily digest.",
	user_not_found: "User not found",
	stocks_limit: `Maximum ${MAX_TRACKED_STOCKS} stocks allowed`,
	preview_email_sent:
		"Preview email sent successfully. Please check your email inbox and spam folder.",
	preview_sms_sent: "Preview SMS sent successfully",
	preview_rate_limited: "Too many preview requests. Please try again later.",
	preview_sms_missing_phone: "Add a phone number before sending SMS previews.",
	preview_sms_unverified:
		"Verify your phone number before sending SMS previews.",
	preview_failed: "Failed to send preview notification. Please try again.",
	email_notifications_disabled: "Email notifications are disabled.",
	daily_digest_sent: "Daily digest sent.",
	daily_digest_disabled: "Daily digest is disabled.",
	daily_digest_send_failed: "Failed to send daily digest. Please try again.",
	daily_digest_rate_limited:
		"Too many manual digest requests. Please try again later.",
	daily_digest_timed_out: "Daily digest request timed out. Please try again.",
	daily_digest_skip_failed:
		"Failed to skip the next daily digest. Please try again.",
} as const;

export type MessageKey = keyof typeof MESSAGE_ALLOWLIST;

export function formatMessage(message: string | null): string {
	if (!message) return "";

	if (Object.hasOwn(MESSAGE_ALLOWLIST, message)) {
		return MESSAGE_ALLOWLIST[message as MessageKey];
	}

	rootLogger.warn("Unknown status message key", { message });
	return "";
}
