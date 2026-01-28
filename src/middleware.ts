import { defineMiddleware } from "astro:middleware";
import { validateEnv } from "./lib/db/env";

// Lazy validation flag - only validate once on first request
let envValidated = false;

export const onRequest = defineMiddleware(async (_context, next) => {
	// Validate environment variables on first request
	// This ensures validation happens after Vercel injects env vars at runtime
	if (!envValidated) {
		validateEnv();
		envValidated = true;
	}
	const requestId = crypto.randomUUID();
	_context.locals.requestId = requestId;

	const response = await next();
	const csp = [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"frame-src 'self' https://newassets.hcaptcha.com https://hcaptcha.com https://*.hcaptcha.com",
		"img-src 'self' data: https:",
		"script-src 'self' 'unsafe-inline' https://js.hcaptcha.com",
		"style-src 'self' 'unsafe-inline'",
		"connect-src 'self' https:",
		"font-src 'self' data:",
		"form-action 'self'",
	].join("; ");

	const applySecurityHeaders = (headers: Headers) => {
		headers.set("x-request-id", requestId);
		headers.set("content-security-policy", csp);
		headers.set("cross-origin-opener-policy", "same-origin");
		headers.set("x-frame-options", "DENY");
		headers.set(
			"strict-transport-security",
			"max-age=63072000; includeSubDomains; preload",
		);
	};
	// Some platform responses expose immutable headers; if response.headers.set throws,
	// clone with new Headers(...) and return a new Response with updated headers.
	try {
		applySecurityHeaders(response.headers);
		return response;
	} catch {
		const headers = new Headers(response.headers);
		applySecurityHeaders(headers);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
});
