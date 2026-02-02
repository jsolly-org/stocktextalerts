import { defineMiddleware } from "astro:middleware";
import { validateEnv } from "./lib/db/env";

// Lazy validation flag - only validate once on first request
let envValidated = false;

const CSP = (() => {
	const isVercelPreview =
		process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview";

	const frameSrc = [
		"'self'",
		"https://newassets.hcaptcha.com",
		"https://hcaptcha.com",
		"https://*.hcaptcha.com",
		...(isVercelPreview ? ["https://vercel.live"] : []),
	].join(" ");

	const scriptSrc = [
		"'self'",
		"'unsafe-inline'",
		"https://js.hcaptcha.com",
		"https://www.ssa.gov",
		"https://ajax.googleapis.com",
		...(isVercelPreview ? ["https://vercel.live"] : []),
	].join(" "); // ANDI: SSA + jQuery

	const connectSrc = [
		"'self'",
		"https:",
		...(isVercelPreview ? ["https://vercel.live"] : []),
	].join(" ");

	return [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		`frame-src ${frameSrc}`,
		"img-src 'self' data: https:",
		`script-src ${scriptSrc}`,
		"style-src 'self' 'unsafe-inline' https://www.ssa.gov", // ANDI stylesheet
		`connect-src ${connectSrc}`,
		"font-src 'self' data:",
		"form-action 'self'",
	].join("; ");
})();

const applySecurityHeaders = (headers: Headers, requestId: string) => {
	headers.set("x-request-id", requestId);
	headers.set("content-security-policy", CSP);
	headers.set("cross-origin-opener-policy", "same-origin");
	headers.set("x-frame-options", "DENY");
	headers.set(
		"strict-transport-security",
		"max-age=63072000; includeSubDomains; preload",
	);
};

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
	// Some platform responses expose immutable headers; if response.headers.set throws,
	// clone with new Headers(...) and return a new Response with updated headers.
	try {
		applySecurityHeaders(response.headers, requestId);
		return response;
	} catch {
		const headers = new Headers(response.headers);
		applySecurityHeaders(headers, requestId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
});
