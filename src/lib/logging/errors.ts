/** Human-readable message for API responses and DB columns — not for logger.error context. */
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

/** Third argument to logger.error — preserves Postgrest-like plain objects. */
export function createErrorForLogging(error: unknown): unknown {
	if (error instanceof Error) {
		return error;
	}
	// The logger's serializeError handles plain objects with a `message` field
	// directly; wrapping them in `new Error(...)` would discard code/hint/details.
	if (error !== null && typeof error === "object") {
		return error;
	}
	return new Error(String(error));
}
