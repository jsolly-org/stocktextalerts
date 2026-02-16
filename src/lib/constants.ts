import { MAX_TRACKED_ASSETS } from "./db/database-errors";
import { rootLogger } from "./logging";

/* =============
Dashboard Form IDs
============= */

/** DOM id for the notification preferences form. */
export const DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID =
	"dashboard-notification-preferences-form";
/** DOM id for the "save status" element for notification preferences. */
export const DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID =
	"dashboard-notification-preferences-save-status";
/** DOM id for the tracked-assets (watchlist) form. */
export const DASHBOARD_ASSETS_FORM_ID = "dashboard-assets-form";
/** DOM id for the "save status" element for tracked-assets (watchlist). */
export const DASHBOARD_ASSETS_STATUS_ID = "dashboard-assets-save-status";
/** DOM id for the market notifications form. */
export const DASHBOARD_MARKET_FORM_ID = "dashboard-market-form";
/** DOM id for the daily notifications form. */
export const DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID =
	"dashboard-daily-notifications-form";
/** DOM id for the asset-events notification form. */
export const DASHBOARD_ASSET_EVENTS_FORM_ID = "dashboard-asset-events-form";

/* =============
Status Message Colors
============= */

/** UI tone variants used by status/flash messaging components. */
export type StatusTone = "success" | "error" | "warning" | "info";

/** Allowed flash-message tones (subset of `StatusTone`). */
export type FlashTone = Extract<StatusTone, "success" | "error" | "warning">;
/** Flash message payload used by UI components. */
export type FlashMessage = { tone: FlashTone; message: string };

/** CSS class names for each `StatusTone`. */
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
/** Default time (minutes since local midnight) for market updates. */
export const DEFAULT_MARKET_UPDATE_TIME_MINUTES = 9 * 60; // 9:00 AM local time (minutes since local midnight)

/* =============
Market-open constants align with the US trading session used across scheduling.

Defined in Eastern Time (New York) so market-time calculations are stable across
DST and user timezones; downstream converts as needed for UI and scheduling.
============= */
/** US market open time in ET (minutes since midnight). */
export const US_MARKET_OPEN_EASTERN_MINUTES = 9 * 60 + 30;
/** US market close time in ET (minutes since midnight). */
export const US_MARKET_CLOSE_EASTERN_MINUTES = 16 * 60; // 4:00 PM ET
/** IANA timezone for the US market session constants (ET). */
export const US_MARKET_TIMEZONE = "America/New_York";

/* =============
Password Policy
============= */

/** Minimum password length enforced at the application level. */
export const MIN_PASSWORD_LENGTH = 8;

/* =============
SMS Verification Timing
============= */

const VERIFICATION_EXPIRATION_MINUTES = 10;
/** Verification code lifetime in milliseconds. */
export const VERIFICATION_EXPIRATION_MS =
	VERIFICATION_EXPIRATION_MINUTES * 60 * 1000;

const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;
/** Minimum time between verification-code sends (milliseconds). */
export const VERIFICATION_RESEND_COOLDOWN_MS =
	VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000;

/* =============
Finnhub API
============= */

/** Base URL for Finnhub REST API calls. */
export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

/* =============
Card Gradient Accents
============= */

/** Tailwind class presets for card gradient accents. */
export const CARD_GRADIENT_ACCENTS = {
	primary: "bg-gradient-to-r from-primary via-blue-500 to-primary-soft",
	success:
		"bg-gradient-to-r from-success-strong via-green-400 to-success-strong",
	teal: "bg-gradient-to-r from-teal-500 via-teal-400 to-teal-500",
	purple: "bg-gradient-to-r from-purple-500 via-purple-400 to-purple-500",
	gray: "bg-gradient-to-r from-edge-strong via-muted to-edge-strong",
} as const;

/* =============
Dashboard Sections
============= */

/** Section id fragments used for dashboard navigation and deep links. */
export const DASHBOARD_SECTION_IDS = {
	notificationChannels: "notification-channels",
	assets: "watchlist",
	marketNotifications: "market-notifications",
	assetEvents: "asset-events-notifications",
	dailyNotifications: "daily-notifications",
} as const;

type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

/** Hash links (e.g. `#watchlist`) for each dashboard section. */
export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	notificationChannels: `#${DASHBOARD_SECTION_IDS.notificationChannels}`,
	assets: `#${DASHBOARD_SECTION_IDS.assets}`,
	marketNotifications: `#${DASHBOARD_SECTION_IDS.marketNotifications}`,
	assetEvents: `#${DASHBOARD_SECTION_IDS.assetEvents}`,
	dailyNotifications: `#${DASHBOARD_SECTION_IDS.dailyNotifications}`,
};

/* =============
Status Messages
============= */

/** Whitelist of user-facing status messages keyed by internal codes. */
export const MESSAGE_ALLOWLIST = {
	asset_added: "Asset added successfully",
	asset_removed: "Asset removed successfully",
	assets_updated: "Tracked assets updated successfully",
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
	failed_to_add_asset: "Failed to add asset",
	failed_to_remove_asset: "Failed to remove asset",
	failed_to_update_assets: "Failed to update tracked assets. Please try again.",
	update_failed: "Failed to update. Please try again.",
	server_error: "An error occurred. Please try again",
	phone_not_set: "Add a phone number before verifying.",
	sms_opted_out:
		"SMS is currently paused. Text START to our number to resume SMS notifications.",
	sms_notifications_disabled: "SMS notifications are disabled.",
	notifications_not_configured:
		"Enable at least one notification channel to send updates.",
	user_not_found: "User not found",
	delete_failed: "Failed to delete account. Please try again.",
	delete_partial:
		"Your account data was deleted, but we couldn't fully remove your sign-in. Please sign out and try again.",
	delete_orphaned_auth_failed:
		"Failed to complete account deletion. Please try again.",
	assets_limit: `Maximum ${MAX_TRACKED_ASSETS} assets allowed`,
} as const;

type MessageKey = keyof typeof MESSAGE_ALLOWLIST;

/** Convert a whitelisted status/message key into a user-facing string. */
export function formatMessage(message: string | null): string {
	if (!message) return "";

	if (Object.hasOwn(MESSAGE_ALLOWLIST, message)) {
		return MESSAGE_ALLOWLIST[message as MessageKey];
	}

	rootLogger.warn("Unknown status message key", { message });
	return "";
}
