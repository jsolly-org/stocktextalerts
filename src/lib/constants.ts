import { MAX_TRACKED_STOCKS } from "./db/database-errors";
import { rootLogger } from "./logging";

/* =============
Dashboard Form IDs
============= */

export const DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID =
	"dashboard-notification-preferences-form";
export const DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID =
	"dashboard-notification-preferences-save-status";
export const DASHBOARD_STOCKS_FORM_ID = "dashboard-stocks-form";
export const DASHBOARD_STOCKS_STATUS_ID = "dashboard-stocks-save-status";
export const DASHBOARD_SCHEDULED_FORM_ID = "dashboard-scheduled-form";
export const DASHBOARD_FORMAT_PREFERENCES_FORM_ID =
	"dashboard-format-preferences-form";

/* =============
Status Message Colors
============= */

export type StatusTone = "success" | "error" | "warning" | "info";

export type FlashTone = Extract<StatusTone, "success" | "error" | "warning">;
export type FlashMessage = { tone: FlashTone; message: string };

export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
	success: "status-tone-success",
	error: "status-tone-error",
	warning: "status-tone-warning",
	info: "status-tone-info",
};

/* =============
Time Defaults
============= */

/** Must match: users.timezone DEFAULT in initial_schema.sql */
export const DEFAULT_TIMEZONE = "America/New_York";
export const DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES = 9 * 60; // 9:00 AM local time (minutes since local midnight)

/* =============
SMS Verification Timing
============= */

export const VERIFICATION_EXPIRATION_MINUTES = 10;
export const VERIFICATION_EXPIRATION_MS =
	VERIFICATION_EXPIRATION_MINUTES * 60 * 1000;

export const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;
export const VERIFICATION_RESEND_COOLDOWN_MS =
	VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000;

/* =============
Finnhub API
============= */

export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

/* =============
Card Gradient Accents
============= */

export const CARD_GRADIENT_ACCENTS = {
	primary: "bg-gradient-to-r from-primary via-blue-500 to-primary-soft",
	success:
		"bg-gradient-to-r from-success-strong via-green-400 to-success-strong",
	teal: "bg-gradient-to-r from-teal-500 via-teal-400 to-teal-500",
	gray: "bg-gradient-to-r from-gray-300 via-gray-400 to-gray-300",
} as const;

/* =============
Dashboard Sections
============= */

export const DASHBOARD_SECTION_IDS = {
	notificationChannels: "notification-channels",
	stocks: "tracked-stocks",
	scheduled: "scheduled-notifications",
	preview: "notification-preview",
} as const;

export type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	notificationChannels: `#${DASHBOARD_SECTION_IDS.notificationChannels}`,
	stocks: `#${DASHBOARD_SECTION_IDS.stocks}`,
	scheduled: `#${DASHBOARD_SECTION_IDS.scheduled}`,
	preview: `#${DASHBOARD_SECTION_IDS.preview}`,
};

/* =============
Status Messages
============= */

export const MESSAGE_ALLOWLIST = {
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
	email_change_requested:
		"Check your old and new inboxes to confirm the email change.",
	email_updated: "Email updated successfully.",
	email_change_failed: "Email update failed. Please try again.",
	email_unchanged: "The new email is the same as your current email.",
	password_reset:
		"Password updated successfully! You can now sign in with your new password.",
	account_deleted: "Your account has been permanently deleted.",
	verification_sent: "Verification code sent",
	verification_recently_sent:
		"A verification code was just sent. Please wait a minute and try again.",
	verification_failed: "Verification failed. Please try again.",
	verification_rate_limited:
		"Too many verification attempts. Please wait 15 minutes and try again.",
	invalid_code: "Invalid verification code. Please try again.",
	code_expired: "Verification code has expired. Please request a new code.",
	failed_to_add_stock: "Failed to add stock",
	failed_to_remove_stock: "Failed to remove stock",
	failed_to_update_stocks: "Failed to update tracked stocks. Please try again.",
	update_failed: "Failed to update. Please try again.",
	server_error: "An error occurred. Please try again",
	phone_not_set: "Add a phone number before verifying.",
	sms_notifications_disabled: "SMS notifications are disabled.",
	notifications_not_configured:
		"Enable at least one notification channel to send updates.",
	update_times_required:
		"Choose at least one delivery time (or disable scheduled updates).",
	user_not_found: "User not found",
	delete_failed: "Failed to delete account. Please try again.",
	delete_partial:
		"Your account data was deleted, but we couldn't fully remove your sign-in. Please sign out and try again.",
	delete_orphaned_auth_failed:
		"Failed to complete account deletion. Please try again.",
	stocks_limit: `Maximum ${MAX_TRACKED_STOCKS} stocks allowed`,
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
