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

function postgrestLikeCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) {
		return undefined;
	}
	const code = (error as { code: unknown }).code;
	if (typeof code !== "string") {
		return undefined;
	}
	const trimmed = code.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isGatewayOrTransientUpstreamMessage(message: string): boolean {
	const lower = message.trim().toLowerCase();
	if (/^internal server error\.?$/.test(lower)) {
		return true;
	}
	if (lower.startsWith("upstream html error response")) {
		return true;
	}
	if (lower.includes("upstream connect error")) {
		return true;
	}
	if (lower.includes("disconnect/reset before headers")) {
		return true;
	}
	return false;
}

/**
 * True for API-gateway / CDN blips that supabase-js surfaces without a
 * PostgREST or Postgres `code` (plaintext 555 "Internal server error.", HTML
 * error pages, Envoy connect-refused). Structured SQLSTATE / PGRST codes are
 * real DB failures and must stay pageable.
 */
export function isGatewayOrTransientUpstreamError(error: unknown): boolean {
	if (postgrestLikeCode(error)) {
		return false;
	}
	return isGatewayOrTransientUpstreamMessage(extractErrorMessage(error));
}

type HousekeepingLogger = {
	warn: (message: string, context?: Record<string, unknown>, error?: unknown) => void;
	error: (message: string, context?: Record<string, unknown>, error?: unknown) => void;
};

/** Housekeeping RPCs: gateway blips warn (no pager); coded DB errors still error. */
export function logHousekeepingPurgeFailure(
	logger: HousekeepingLogger,
	message: string,
	context: Record<string, unknown>,
	error: unknown,
): void {
	if (isGatewayOrTransientUpstreamError(error)) {
		logger.warn(message, context, error);
		return;
	}
	logger.error(message, context, error);
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
