const MESSAGE_ALLOWLIST: Record<string, string> = {
	stock_added: "Stock added successfully",
	stock_removed: "Stock removed successfully",
	stocks_updated: "Tracked stocks updated successfully",
	phone_verified: "Phone number verified successfully",
	settings_updated: "Settings updated successfully",
	timezone_updated: "Timezone updated successfully",
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
	user_not_found: "User not found",
	stocks_limit: "Maximum 50 stocks allowed",
	preview_email_sent: "Preview email sent successfully",
	preview_sms_sent: "Preview SMS sent successfully",
	preview_rate_limited: "Too many preview requests. Please try again later.",
	preview_email_disabled: "Email notifications are disabled.",
	preview_sms_disabled: "SMS notifications are disabled.",
	preview_sms_opted_out:
		"SMS notifications are disabled because you opted out.",
	preview_sms_missing_phone: "Add a phone number before sending SMS previews.",
	preview_sms_unverified:
		"Verify your phone number before sending SMS previews.",
	preview_failed: "Failed to send preview notification. Please try again.",
	no_updates: "No changes were made to your preferences.",
};

type MessageKey = keyof typeof MESSAGE_ALLOWLIST;

export function formatMessage(message: MessageKey | null): string {
	if (!message) return "";
	return MESSAGE_ALLOWLIST[message] ?? "";
}

export function truncateSms(message: string, maxLength = 160): string {
	if (message.length <= maxLength) {
		return message;
	}

	const shortened = message.substring(0, maxLength - 3);
	return `${shortened}...`;
}
