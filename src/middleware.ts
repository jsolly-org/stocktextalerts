import { defineMiddleware } from "astro:middleware";

const ORIGIN_CHECK_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);
const FORM_CONTENT_TYPES = [
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
];

const REQUIRED_ENV_VARS = [
	"SUPABASE_URL",
	"SUPABASE_PUBLISHABLE_KEY",
	"SUPABASE_SECRET_KEY",
	"TWILIO_ACCOUNT_SID",
	"TWILIO_AUTH_TOKEN", // Used by /api/messaging/send-sms
	"TWILIO_PHONE_NUMBER",
	"TWILIO_VERIFY_SERVICE_SID",
	"UNSUBSCRIBE_TOKEN_SECRET",
	"RESEND_API_KEY", // Used by /api/messaging/send-email
	"EMAIL_FROM",
	"MASSIVE_API_KEY", // Used by /api/assets/logo/[symbol] proxy — Massive branding images require auth
] as const;

// Lazy validation flag - only validate once on first request
let envValidated = false;

// Re-use the shared readEnv helper (prefers process.env, falls back to
// import.meta.env for Vite dev-server mode).
import { readEnv } from "./lib/db/env";

/**
 * Returns true when the `Content-Type` indicates a form-like submission.
 *
 * Used to emulate (and add logging around) Astro's origin enforcement behavior.
 */
function hasFormLikeContentType(contentType: string | null): boolean {
	if (!contentType) {
		return false;
	}
	const normalized = contentType.toLowerCase();
	return FORM_CONTENT_TYPES.some((candidate) => normalized.includes(candidate));
}

/**
 * Build the Content Security Policy header value.
 *
 * Allows `vercel.live` when running on Vercel (or when the request host looks
 * like a Vercel deployment) to support preview tooling.
 */
function buildCsp(requestHost?: string): string {
	// Allow vercel.live when on Vercel (env at runtime) or when request host is a Vercel deployment (fallback if env unset).
	const isVercel =
		process.env.VERCEL === "1" ||
		(typeof requestHost === "string" && requestHost.endsWith(".vercel.app"));

	const frameSrc = [
		"'self'",
		...(isVercel ? ["https://vercel.live"] : []),
	].join(" ");

	const scriptSrc = [
		"'self'",
		"'unsafe-inline'",
		"https://www.ssa.gov",
		"https://ajax.googleapis.com",
		...(isVercel ? ["https://vercel.live"] : []),
	].join(" "); // ANDI: SSA + jQuery

	// https: does not include wss:; Vercel Live/Preview uses Pusher over wss://
	const connectSrc = [
		"'self'",
		"https:",
		"wss:",
		...(isVercel ? ["https://vercel.live"] : []),
	].join(" ");

	return [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		`frame-src ${frameSrc}`,
		"img-src 'self' data: https:",
		`script-src ${scriptSrc}`,
		"script-src-attr 'none'",
		"style-src 'self' 'unsafe-inline' https://www.ssa.gov", // ANDI stylesheet
		`connect-src ${connectSrc}`,
		"font-src 'self' data:",
		"form-action 'self'",
	].join("; ");
}

/**
 * Parse an Origin-like value and return the normalized origin string.
 *
 * Returns `null` for missing or invalid values.
 */
function normalizeOrigin(value: string | null): string | null {
	if (!value) {
		return null;
	}
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

/**
 * Some proxy headers may include comma-separated values; keep the first one.
 */
function firstHeaderValue(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const first = value.split(",")[0]?.trim();
	return first || null;
}

/**
 * Build acceptable same-origin candidates for CSRF-style origin checks.
 *
 * In serverless/proxied environments, `request.url` can differ from the
 * browser-visible origin. Include host/proxy-derived origins to avoid
 * false positives while keeping strict cross-site blocking.
 */
function collectExpectedOrigins(
	request: Request,
	requestUrl: URL,
): Set<string> {
	const expected = new Set<string>();
	expected.add(requestUrl.origin);

	const host = firstHeaderValue(request.headers.get("host"));
	if (host) {
		expected.add(`${requestUrl.protocol}//${host}`);
	}

	const forwardedHost = firstHeaderValue(
		request.headers.get("x-forwarded-host"),
	);
	const forwardedProto = firstHeaderValue(
		request.headers.get("x-forwarded-proto"),
	);
	if (forwardedHost && forwardedProto) {
		expected.add(`${forwardedProto}://${forwardedHost}`);
	}

	return expected;
}

/**
 * Apply response security headers and request correlation metadata.
 *
 * Must be safe to call multiple times and should not assume mutable `Headers`
 * (some platforms return immutable header bags).
 */
const applySecurityHeaders = (
	headers: Headers,
	requestId: string,
	request?: Request,
) => {
	headers.set("x-request-id", requestId);
	headers.set(
		"content-security-policy",
		buildCsp(request?.url ? new URL(request.url).host : undefined),
	);
	headers.set("cross-origin-opener-policy", "same-origin");
	headers.set("origin-agent-cluster", "?1");
	headers.set("x-content-type-options", "nosniff");
	headers.set("x-frame-options", "DENY");
	headers.set("x-permitted-cross-domain-policies", "none");
	headers.set("referrer-policy", "strict-origin-when-cross-origin");
	headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
	headers.set(
		"strict-transport-security",
		"max-age=63072000; includeSubDomains; preload",
	);
};

/**
 * Global Astro middleware.
 *
 * - Validates required environment variables (once, lazily).
 * - Assigns a per-request ID available via `context.locals.requestId`.
 * - Applies security headers (CSP, HSTS, etc).
 * - Enforces CSRF-style same-origin checks for mutation requests.
 */
export const onRequest = defineMiddleware(async (context, next) => {
	// Validate environment variables on first request
	// This ensures validation happens after Vercel injects env vars at runtime
	if (!envValidated) {
		const missing: string[] = REQUIRED_ENV_VARS.filter(
			(name) => !readEnv(name),
		);
		if (!readEnv("VERCEL_URL") && !readEnv("VERCEL_PROJECT_PRODUCTION_URL")) {
			missing.push("VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL");
		}
		if (missing.length > 0) {
			throw new Error(
				`Missing required environment variables: ${missing.join(", ")}\n` +
					"Please check your .env file and ensure all required variables are set.",
			);
		}
		envValidated = true;
	}
	const requestId = crypto.randomUUID();
	context.locals.requestId = requestId;
	const requestUrl = new URL(context.request.url);

	// Keep Astro checkOrigin disabled and enforce origin checks here so
	// same-origin validation can account for proxy headers.
	// Webhook endpoints use their own authentication (e.g. Twilio signature
	// validation) and must not be blocked by browser-oriented CSRF checks.
	const WEBHOOK_PATHS = ["/api/messaging/inbound"];
	const isWebhookPath = WEBHOOK_PATHS.some((p) => requestUrl.pathname === p);
	if (ORIGIN_CHECK_METHODS.has(context.request.method) && !isWebhookPath) {
		// If Astro's built-in origin enforcement is enabled, avoid duplicate checks.
		const astroCheckOriginEnabled =
			readEnv("ASTRO_SECURITY_CHECK_ORIGIN")?.toLowerCase() === "true";
		if (!astroCheckOriginEnabled) {
			const origin = context.request.headers.get("origin");
			const contentType = context.request.headers.get("content-type");
			const hasContentType = context.request.headers.has("content-type");
			const formLikeContentType = hasFormLikeContentType(contentType);
			// Only enforce cross-site form blocking when Origin is present and cross-origin.
			const shouldEnforce =
				origin !== null && (hasContentType ? formLikeContentType : true);
			const normalizedOrigin = normalizeOrigin(origin);
			const expectedOrigins = collectExpectedOrigins(
				context.request,
				requestUrl,
			);
			const isSameOrigin =
				normalizedOrigin !== null && expectedOrigins.has(normalizedOrigin);
			if (shouldEnforce && !isSameOrigin) {
				const message = `Cross-site ${context.request.method} form submissions are forbidden`;
				const blockedResponse = new Response(message, { status: 403 });
				try {
					applySecurityHeaders(
						blockedResponse.headers,
						requestId,
						context.request,
					);
					return blockedResponse;
				} catch {
					const headers = new Headers(blockedResponse.headers);
					applySecurityHeaders(headers, requestId, context.request);
					return new Response(message, { status: 403, headers });
				}
			}
		}
	}

	const response = await next();
	// Some platform responses expose immutable headers; if response.headers.set throws,
	// clone with new Headers(...) and return a new Response with updated headers.
	try {
		applySecurityHeaders(response.headers, requestId, context.request);
		return response;
	} catch {
		const headers = new Headers(response.headers);
		applySecurityHeaders(headers, requestId, context.request);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
});
