import { defineMiddleware } from "astro:middleware";

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

export const onRequest = defineMiddleware(async (context, next) => {
	// Validate environment variables on first request
	// This ensures validation happens after Vercel injects env vars at runtime
	if (!envValidated) {
		const missing: string[] = REQUIRED_ENV_VARS.filter((name) => {
			const value = import.meta.env[name];
			return !value || value.trim() === "";
		});
		const vercelUrl = import.meta.env.VERCEL_URL;
		const vercelProductionUrl = import.meta.env.VERCEL_PROJECT_PRODUCTION_URL;
		if (
			(!vercelUrl || vercelUrl.trim() === "") &&
			(!vercelProductionUrl || vercelProductionUrl.trim() === "")
		) {
			missing.push("VERCEL_URL (or VERCEL_PROJECT_PRODUCTION_URL)");
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
