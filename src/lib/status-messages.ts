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
	unauthorized: "Please sign in to continue.",
	failed_to_update_settings: "Failed to update settings. Please try again.",
	failed_to_update_timezone: "Failed to update timezone. Please try again.",
	failed_to_dismiss_timezone_banner:
		"Failed to dismiss timezone banner. Please try again.",
	invalid_form:
		"There was a problem with your submission. Please check the form and try again.",
	invalid_credentials: "Invalid email or password.",
	invalid_verification: "Verification link is invalid or expired.",
	email_required: "No email address found.",
	missing_fields: "Email and password are required.",
	user_already_exists: "An account with this email already exists.",
	profile_creation_failed:
		"Failed to create user profile. Please try again or contact support.",
	captcha_required: "Please complete the CAPTCHA and try again.",
	captcha_failed: "CAPTCHA verification failed. Please try again.",
	failed: "Request failed. Please try again.",
	rate_limit: "You've made too many requests. Please try again later.",
	password_mismatch: "Passwords do not match.",
	weak_password:
		"Password does not meet security requirements. Please choose a stronger password.",
	expired: "This password reset link has expired.",
	invalid_token: "This password reset link is invalid.",
	password_reset_sent:
		"If an account exists for that email, a reset link has been sent.",
	verification_email_sent: "Verification email sent! Check your inbox.",
	password_reset:
		"Password updated successfully! You can now sign in with your new password.",
	account_deleted: "Your account has been permanently deleted.",
	verification_sent: "Verification code sent",
	verification_failed: "Verification failed. Please try again.",
	invalid_code: "Invalid verification code. Please try again.",
	failed_to_add_stock: "Failed to add stock",
	failed_to_remove_stock: "Failed to remove stock",
	failed_to_update_stocks: "Failed to update tracked stocks. Please try again.",
	update_failed: "Failed to update. Please try again.",
	server_error: "An error occurred. Please try again",
	phone_not_set: "Add a phone number before verifying.",
	sms_opted_out: "SMS notifications are disabled for this number",
	sms_notifications_disabled: "SMS notifications are disabled.",
	notifications_not_configured:
		"Enable at least one notification channel to send a daily digest.",
	user_not_found: "User not found",
	delete_failed: "Failed to delete account. Please try again.",
	delete_partial:
		"Your account data was deleted, but we couldn't fully remove your sign-in. Please sign out and try again.",
	delete_orphaned_auth_failed:
		"Failed to complete account deletion. Please try again.",
	stocks_limit: `Maximum ${MAX_TRACKED_STOCKS} stocks allowed`,
	preview_email_sent:
		"Preview email sent successfully. Please check your email inbox and spam folder.",
	preview_sms_sent: "Preview SMS sent successfully",
	preview_rate_limited: "Too many preview requests. Please try again later.",
	preview_sms_missing_phone: "Add a phone number before sending SMS previews.",
	preview_sms_unverified:
		"Verify your phone number before sending SMS previews.",
	preview_sms_unavailable:
		"SMS previews are currently unavailable. Please try again later.",
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
	daily_digest_skip_update_failed:
		"Daily digest was sent, but we couldn't update your next scheduled digest. Please try again.",
	preview_rate_limit_unexpected:
		"Preview request could not be processed. Please try again.",
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
