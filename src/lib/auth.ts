export function getAuthErrorMessage(error: string | null): string {
	if (!error) return "";

	switch (error) {
		case "unauthorized":
			return "Please sign in to continue";
		case "phone_not_set":
			return "Add a phone number before verifying";
		case "invalid_code":
			return "Invalid or expired verification code";
		case "rate_limit":
		case "too_many_attempts":
			return "Too many attempts. Please try again later.";
		case "captcha_required":
			return "Please complete the CAPTCHA and try again.";
		case "captcha_failed":
			return "CAPTCHA verification failed. Please try again.";
		case "failed":
			return "Failed to process request. Please try again.";
		case "server_error":
			return "Something went wrong. Please try again later.";
		case "invalid_credentials":
			return "Invalid email or password.";
		case "user_not_found":
			return "No account exists with this email.";
		case "delete_failed":
			return "Failed to delete account. Please try again.";
		case "delete_partial":
			return "Your account data was deleted, but we couldn't fully remove your sign-in. Please sign out and try again.";
		case "delete_orphaned_auth_failed":
			return "Failed to complete account deletion. Please try again.";
		case "update_failed":
			return "Failed to update preferences. Please try again.";
		default:
			return "An unexpected error occurred. Please try again.";
	}
}

export function getAuthSuccessMessage(code: string | null): string {
	if (!code) return "";

	switch (code) {
		case "password_reset":
			return "Password updated successfully! You can now sign in with your new password.";
		case "phone_verified":
			return "Phone verified successfully.";
		case "account_deleted":
			return "Your account has been permanently deleted.";
		default:
			console.warn(`Unknown auth success code: ${code}`);
			return "";
	}
}
