/**
 * Extracts a human-readable error message from an unknown error value.
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
 * Converts an unknown error value to an Error instance for logging.
 * Always returns an Error to ensure consistent logging behavior.
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
