type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown> & {
	requestId?: string;
};

type LogEntry = {
	timestamp: string;
	level: LogLevel;
	message: string;
	context?: Record<string, unknown>;
	requestId?: string;
	error?: {
		name?: string;
		message: string;
		stack?: string;
		raw?: unknown;
		cause?: unknown;
	};
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Require separators or a country code to reduce false positives (may miss bare digits).
// Matches: +1 (415) 555-1234, (415) 555-1234, 415-555-1234, etc.
const PHONE_CANDIDATE_RE =
	/(?:\+\d{1,3}[\s().-]*)?\(?\d{3}\)?[\s().-]*\d{3}[\s().-]*\d{4}/g;

/** Context keys that indicate secrets; always redact to avoid leaking credentials. */
const SENSITIVE_KEY_PATTERNS = [
	"secret",
	"password",
	"apikey",
	"api_key",
	"credential",
	"authtoken",
	"auth_token",
	"access_token",
	"refresh_token",
];

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		lower === "token" ||
		lower.endsWith("token") ||
		SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p))
	);
}

function maskPiiInContext(
	context: LogContext,
	maskPiiEnabled: boolean,
): LogContext {
	const masked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(context)) {
		if (key === "requestId") {
			masked[key] = value;
			continue;
		}
		if (isSensitiveKey(key)) {
			masked[key] = "[REDACTED]";
			continue;
		}
		if (!maskPiiEnabled) {
			masked[key] = value;
			continue;
		}
		const lowerKey = key.toLowerCase();
		const isPhoneKey =
			lowerKey.includes("phone") ||
			lowerKey === "countrycode" ||
			lowerKey === "country_code";
		let looksLikePhone = false;
		if (typeof value === "string") {
			looksLikePhone = PHONE_CANDIDATE_RE.test(value);
			PHONE_CANDIDATE_RE.lastIndex = 0;
		}

		if (isPhoneKey || looksLikePhone) {
			masked[key] = "[REDACTED]";
			continue;
		}

		masked[key] = value;
	}
	return masked as LogContext;
}

function maskPiiInString(value: string, maskPiiEnabled: boolean): string {
	if (!maskPiiEnabled) {
		return value;
	}
	const maskedEmail = value.replace(EMAIL_RE, "[REDACTED]");
	return maskedEmail.replace(PHONE_CANDIDATE_RE, (match) => {
		const digits = match.replace(/\D/g, "");
		if (digits.length < 10) {
			return match;
		}
		return "[REDACTED]";
	});
}

function serializeError(error: unknown): LogEntry["error"] {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		};
	}

	if (typeof error === "string") {
		return { message: error };
	}

	return {
		message: "Non-Error thrown",
		raw: error,
	};
}

function getMaskPiiEnabled(): boolean {
	// readEnv would create a circular import (logging ← env ← logging),
	// so access process.env directly here. LOG_MASK_PII is a non-secret config
	// flag, safe to read from either source.
	const value =
		process.env.LOG_MASK_PII ??
		(typeof import.meta !== "undefined" && import.meta.env
			? import.meta.env.LOG_MASK_PII
			: undefined);
	const normalized = typeof value === "string" ? value : String(value ?? "");
	return normalized.toLowerCase() !== "false";
}

function safeJsonStringify(value: unknown, maskPiiEnabled: boolean): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, entry) => {
		if (typeof entry === "bigint") {
			return entry.toString();
		}
		if (entry instanceof Error) {
			return serializeError(entry);
		}
		if (typeof entry === "string") {
			return maskPiiInString(entry, maskPiiEnabled);
		}
		if (typeof entry === "object" && entry !== null) {
			if (seen.has(entry)) {
				return "[Circular]";
			}
			seen.add(entry);
		}
		return entry;
	});
}

function buildEntry(
	level: LogLevel,
	message: string,
	context: LogContext | undefined,
	error: unknown | undefined,
	maskPiiEnabled: boolean,
): LogEntry {
	const maskedContext = context
		? maskPiiInContext(context, maskPiiEnabled)
		: undefined;
	const { requestId, ...rest } = maskedContext ?? {};
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
	};

	if (requestId) {
		entry.requestId = requestId;
	}
	if (Object.keys(rest).length > 0) {
		entry.context = rest;
	}
	if (error !== undefined) {
		entry.error = serializeError(error);
	}

	return entry;
}

function writeLog(
	level: LogLevel,
	message: string,
	context?: LogContext,
	error?: unknown,
) {
	const maskPiiEnabled = getMaskPiiEnabled();
	const entry = buildEntry(level, message, context, error, maskPiiEnabled);
	const output = safeJsonStringify(entry, maskPiiEnabled);

	switch (level) {
		case "debug":
			console.debug(output);
			break;
		case "info":
			console.info(output);
			break;
		case "warn":
			console.warn(output);
			break;
		case "error":
			console.error(output);
			break;
	}
}

/** Minimal structured logger interface used across the app. */
export type Logger = {
	debug: (message: string, context?: LogContext) => void;
	info: (message: string, context?: LogContext, error?: unknown) => void;
	warn: (message: string, context?: LogContext, error?: unknown) => void;
	error: (message: string, context?: LogContext, error?: unknown) => void;
};

/**
 * Create a structured logger with optional base context merged into every log call.
 */
export function createLogger(baseContext: LogContext = {}): Logger {
	return {
		debug(message, context) {
			writeLog("debug", message, { ...baseContext, ...context });
		},
		info(message, context, error) {
			writeLog("info", message, { ...baseContext, ...context }, error);
		},
		warn(message, context, error) {
			writeLog("warn", message, { ...baseContext, ...context }, error);
		},
		error(message, context, error) {
			writeLog("error", message, { ...baseContext, ...context }, error);
		},
	};
}

/** Process-wide default logger with no base context. */
export const rootLogger = createLogger();
