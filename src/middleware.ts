import { defineMiddleware } from "astro:middleware";
import { rootLogger } from "./lib/logging";

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
	"TWILIO_AUTH_TOKEN",
	"TWILIO_PHONE_NUMBER",
	"TWILIO_VERIFY_SERVICE_SID",
	"CRON_SECRET",
	"RESEND_API_KEY",
	"EMAIL_FROM",
	"FINNHUB_API_KEY",
] as const;

// Lazy validation flag - only validate once on first request
let envValidated = false;

const metaEnv = import.meta.env as unknown as Record<
	string,
	string | undefined
>;

/**
 * Read an environment variable from the runtime environment.
 *
 * Prefers `import.meta.env` (Vite/Astro build/runtime) and falls back to
 * `process.env` (Node/Vercel runtime). Empty strings are treated as unset.
 */
function readEnv(name: string): string | undefined {
	const fromMeta = metaEnv[name];
	if (typeof fromMeta === "string" && fromMeta.trim() !== "") {
		return fromMeta;
	}
	const fromProcess = process.env[name];
	return typeof fromProcess === "string" ? fromProcess : undefined;
}

/**
 * Feature-flag for temporary auth origin debugging logs.
 *
 * Keep this enabled only while investigating cross-site origin blocks on auth
 * endpoints; it increases log volume and may include header context.
 */
function isAuthOriginDebugEnabled(): boolean {
	// Toggle via env var to avoid redeployments.
	// Keep disabled by default to reduce log volume.
	return readEnv("AUTH_ORIGIN_DEBUG")?.toLowerCase() === "true";
}

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

type AuthOriginDebugHeaderContext = {
	requestId: string;
	method: string;
	pathname: string;
	urlOrigin: string;
	headerHost: string | null;
	headerOrigin: string | null;
	headerReferer: string | null;
	headerXForwardedHost: string | null;
	headerXForwardedProto: string | null;
	headerXForwardedPort: string | null;
	headerContentType: string | null;
	headerSecFetchSite: string | null;
};

function collectAuthOriginDebugHeaderContext(
	request: Request,
	requestId: string,
	requestUrl: URL,
): AuthOriginDebugHeaderContext {
	return {
		requestId,
		method: request.method,
		pathname: requestUrl.pathname,
		urlOrigin: requestUrl.origin,
		headerHost: request.headers.get("host"),
		headerOrigin: request.headers.get("origin"),
		headerReferer: request.headers.get("referer"),
		headerXForwardedHost: request.headers.get("x-forwarded-host"),
		headerXForwardedProto: request.headers.get("x-forwarded-proto"),
		headerXForwardedPort: request.headers.get("x-forwarded-port"),
		headerContentType: request.headers.get("content-type"),
		headerSecFetchSite: request.headers.get("sec-fetch-site"),
	};
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
 * - Temporarily enforces and logs origin checks for auth endpoints while
 *   investigating blocked cross-site requests.
 */
export const onRequest = defineMiddleware(async (context, next) => {
	// Validate environment variables on first request
	// This ensures validation happens after Vercel injects env vars at runtime
	if (!envValidated) {
		const missing: string[] = REQUIRED_ENV_VARS.filter((name) => {
			const value = readEnv(name);
			return !value || value.trim() === "";
		});
		const vercelUrl = readEnv("VERCEL_URL");
		const vercelProductionUrl = readEnv("VERCEL_PROJECT_PRODUCTION_URL");
		if (
			(!vercelUrl || vercelUrl.trim() === "") &&
			(!vercelProductionUrl || vercelProductionUrl.trim() === "")
		) {
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

	// TEMPORARY DEBUGGING NOTE:
	// Do not remove this block until the auth origin investigation is complete.
	// This replaces Astro's built-in security.checkOrigin so blocked requests
	// can be logged with header context in production while preserving CSRF checks.
	if (ORIGIN_CHECK_METHODS.has(context.request.method)) {
		const origin = context.request.headers.get("origin");
		const contentType = context.request.headers.get("content-type");
		const hasContentType = context.request.headers.has("content-type");
		const formLikeContentType = hasFormLikeContentType(contentType);
		const shouldEnforce = hasContentType ? formLikeContentType : true;
		// Treat missing Origin header as same-origin (browsers omit it for some legitimate requests).
		const isSameOrigin = !origin || origin === requestUrl.origin;
		if (shouldEnforce && origin && !isSameOrigin) {
			if (
				isAuthOriginDebugEnabled() &&
				requestUrl.pathname.startsWith("/api/auth/")
			) {
				rootLogger.info("Auth origin debug: blocked cross-site form request", {
					...collectAuthOriginDebugHeaderContext(
						context.request,
						requestId,
						requestUrl,
					),
					hasContentType,
					formLikeContentType,
					shouldEnforce,
					isSameOrigin,
				});
			}
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

	if (
		isAuthOriginDebugEnabled() &&
		context.request.method === "POST" &&
		requestUrl.pathname.startsWith("/api/auth/")
	) {
		rootLogger.info("Auth origin debug: request reached middleware", {
			...collectAuthOriginDebugHeaderContext(
				context.request,
				requestId,
				requestUrl,
			),
		});
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
