/**
 * Extract a best-effort error message string from an unknown error-like value.
 */
export function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return String(error);
}

/**
 * Convert an unknown error-like value into an `Error` for logging.
 */
export function createErrorForLogging(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return new Error(error.message);
	}
	return new Error(String(error));
}
