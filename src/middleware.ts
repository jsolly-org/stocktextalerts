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
	// Some platform responses expose immutable headers; if response.headers.set throws,
	// clone with new Headers(...) and return a new Response with updated headers.
	try {
		response.headers.set("x-request-id", requestId);
		return response;
	} catch {
		const headers = new Headers(response.headers);
		headers.set("x-request-id", requestId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
});
