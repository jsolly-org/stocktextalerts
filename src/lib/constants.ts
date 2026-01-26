import { MAX_TRACKED_STOCKS } from "./db/database-errors";
import { rootLogger } from "./logging";

/* =============
Dashboard Form IDs
============= */

export const DASHBOARD_FORM_ID = "dashboard-preferences-form";
export const DASHBOARD_STATUS_ID = "dashboard-preferences-save-status";
export const DASHBOARD_STOCKS_FORM_ID = "dashboard-stocks-form";
export const DASHBOARD_STOCKS_STATUS_ID = "dashboard-stocks-save-status";

/* =============
Flash Message Parameters
============= */

export const FLASH_PARAM_KEYS = [
	"success",
	"error",
	"warning",
	"change_phone",
] as const;

/* =============
Status Message Colors
============= */

export type StatusTone = "success" | "error" | "warning" | "info";

export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
	success: "status-tone-success",
	error: "status-tone-error",
	warning: "status-tone-warning",
	info: "status-tone-info",
};

/* =============
Time Defaults
============= */

export const DEFAULT_TIMEZONE = "America/New_York";

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
	preferences: "notification-preferences",
	stocks: "tracked-stocks",
	scheduled: "scheduled-notifications",
	preview: "preview-notifications",
} as const;

export type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	preferences: `#${DASHBOARD_SECTION_IDS.preferences}`,
	stocks: `#${DASHBOARD_SECTION_IDS.stocks}`,
	scheduled: `#${DASHBOARD_SECTION_IDS.scheduled}`,
	preview: `#${DASHBOARD_SECTION_IDS.preview}`,
};

type DashboardRedirectOptions = {
	success?: string;
	error?: string;
	warning?: string;
	section?: DashboardSection;
};

/** Builds a dashboard URL with flash params and an optional section hash. */
export function buildDashboardRedirect({
	success,
	error,
	warning,
	section,
}: DashboardRedirectOptions): string {
	const url = new URL("/dashboard", "http://localhost");
	if (success) url.searchParams.set("success", success);
	if (error) url.searchParams.set("error", error);
	if (warning) url.searchParams.set("warning", warning);
	const hash = section ? DASHBOARD_SECTION_HASHES[section] : "";
	return `${url.pathname}${url.search}${hash}`;
}

/** Maps a `#hash` to a known dashboard section (or `null` if unknown). */
export function resolveDashboardSectionFromHash(
	hash: string,
): DashboardSection | null {
	if (!hash) return null;
	const section = Object.entries(DASHBOARD_SECTION_HASHES).find(
		([, sectionHash]) => sectionHash === hash,
	)?.[0] as DashboardSection | undefined;
	return section ?? null;
}

const PREFERENCES_KEYS = new Set([
	"settings_updated",
	"timezone_updated",
	"timezone_banner_dismissed",
	"phone_verified",
	"verification_failed",
	"invalid_code",
	"code_expired",
	"verification_recently_sent",
	"phone_not_set",
	"failed_to_update_settings",
	"failed_to_update_timezone",
	"failed_to_dismiss_timezone_banner",
]);

const STOCKS_KEYS = new Set([
	"stocks_updated",
	"stocks_limit",
	"failed_to_update_stocks",
]);

const SCHEDULED_KEYS = new Set([
	"daily_digest_sent",
	"daily_digest_disabled",
	"daily_digest_send_failed",
	"daily_digest_rate_limited",
	"daily_digest_timed_out",
	"daily_digest_skip_failed",
	"daily_digest_skip_update_failed",
	"notifications_not_configured",
]);

const PREVIEW_KEYS = new Set([
	"preview_email_sent",
	"preview_sms_sent",
	"preview_rate_limited",
	"preview_rate_limit_unexpected",
	"preview_sms_missing_phone",
	"preview_sms_unverified",
	"preview_sms_unavailable",
	"preview_failed",
	"email_notifications_disabled",
	"sms_notifications_disabled",
	"sms_opted_out",
]);

export function resolveSectionFromKey(
	messageKey: string | null,
): DashboardSection | null {
	if (!messageKey) {
		return null;
	}
	if (PREFERENCES_KEYS.has(messageKey)) return "preferences";
	if (STOCKS_KEYS.has(messageKey)) return "stocks";
	if (SCHEDULED_KEYS.has(messageKey)) return "scheduled";
	if (PREVIEW_KEYS.has(messageKey)) return "preview";
	if (messageKey === "invalid_form") return "preferences";
	if (messageKey === "server_error") return "preferences";
	if (messageKey === "update_failed") return "preferences";
	return null;
}

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
	password_reset:
		"Password updated successfully! You can now sign in with your new password.",
	account_deleted: "Your account has been permanently deleted.",
	verification_sent: "Verification code sent",
	verification_recently_sent:
		"A verification code was just sent. Please wait a minute and try again.",
	verification_failed: "Verification failed. Please try again.",
	invalid_code: "Invalid verification code. Please try again.",
	code_expired: "Verification code has expired. Please request a new code.",
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

/** Returns a human-friendly message for allowlisted keys; otherwise logs and returns empty. */
export function formatMessage(message: string | null): string {
	if (!message) return "";

	if (Object.hasOwn(MESSAGE_ALLOWLIST, message)) {
		return MESSAGE_ALLOWLIST[message as MessageKey];
	}

	rootLogger.warn("Unknown status message key", { message });
	return "";
}
