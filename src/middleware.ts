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
	return next();
});
