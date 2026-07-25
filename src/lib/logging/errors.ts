/** Collapse CDN/proxy HTML error pages into a short log-safe message. */
export function summarizeErrorMessageForLog(message: string): string {
	if (!looksLikeHtmlErrorPage(message)) {
		return message;
	}
	const code =
		message.match(/Error code\s+(\d{3})\b/i)?.[1] ??
		message.match(/\|\s*(\d{3}):\s/)?.[1] ??
		message.match(/\b(\d{3}):\s+(?:SSL|Web server|Origin|Bad gateway|Error)\b/i)?.[1];
	return code ? `Upstream HTML error response (HTTP ${code})` : "Upstream HTML error response";
}

function looksLikeHtmlErrorPage(message: string): boolean {
	const trimmed = message.trimStart();
	if (trimmed.length < 200) {
		return false;
	}
	const head = trimmed.slice(0, 256).toLowerCase();
	return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Human-readable message for API responses and DB columns — not for logger.error context. */
export function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return summarizeErrorMessageForLog(error.message);
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return summarizeErrorMessageForLog(error.message);
	}
	return String(error);
}

/** Third argument to logger.error — preserves Postgrest-like plain objects. */
export function createErrorForLogging(error: unknown): unknown {
	if (error instanceof Error) {
		const summarized = summarizeErrorMessageForLog(error.message);
		if (summarized === error.message) {
			return error;
		}
		const wrapped = new Error(summarized);
		wrapped.name = error.name;
		wrapped.stack = error.stack;
		wrapped.cause = error.cause;
		return wrapped;
	}
	// The logger's serializeError handles plain objects with a `message` field
	// directly; wrapping them in `new Error(...)` would discard code/hint/details.
	if (error !== null && typeof error === "object") {
		if ("message" in error && typeof error.message === "string") {
			const summarized = summarizeErrorMessageForLog(error.message);
			if (summarized !== error.message) {
				return { ...error, message: summarized };
			}
		}
		return error;
	}
	return new Error(String(error));
}
