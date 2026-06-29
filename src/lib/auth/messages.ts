import { formatMessage } from "../messaging/status-messages";

/**
 * Convert an auth error code/key into a user-facing message string.
 */
export function getAuthErrorMessage(error: string | null): string {
	return formatMessage(error);
}

/**
 * Convert an auth success code/key into a user-facing message string.
 */
export function getAuthSuccessMessage(code: string | null): string {
	return formatMessage(code);
}
