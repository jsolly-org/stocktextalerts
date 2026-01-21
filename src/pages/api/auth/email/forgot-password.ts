import type { APIRoute } from "astro";
import { getSiteUrl } from "../../../../lib/db/env";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

/*
 * Regex pattern to extract seconds from Supabase Auth rate limit error messages.
 *
 * Supabase Auth rate limit errors (status 429 or code "rate_limit_exceeded") include
 * a message with the remaining wait time in the format: "N seconds" or "N second".
 * Example: "Please try again in 60 seconds" or "Rate limit exceeded. Try again in 120 seconds"
 *
 * Note: Supabase Auth errors don't expose response headers (including Retry-After),
 * so we must parse the message text to extract retry timing. This is documented
 * as a limitation in Supabase's error handling.
 *
 * The pattern matches one or more digits followed by optional whitespace and "second" or "seconds".
 */
const RATE_LIMIT_SECONDS_PATTERN = /\b(\d+)\s+seconds?\b/i;

/*
 * Default wait time for password reset rate limits.
 * Supabase defaults to 60 seconds between password reset requests for the same email.
 */
const DEFAULT_PASSWORD_RESET_RATE_LIMIT_SECONDS = 60;

function parseRateLimitSeconds(message: string | undefined): number | null {
	if (!message) {
		return null;
	}

	const match = message.match(RATE_LIMIT_SECONDS_PATTERN);
	if (!match) {
		return null;
	}

	const parsedSeconds = Number.parseInt(match[1], 10);
	if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
		return null;
	}

	return parsedSeconds;
}

export const POST: APIRoute = async ({ request, redirect, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();

	try {
		const formData = await request.formData();
		const parsed = parseWithSchema(formData, {
			email: { type: "string", required: true },
			captcha_token: { type: "string", required: true },
		} as const);

		if (!parsed.ok) {
			const errors = parsed.allErrors;
			logger.info("Password reset request rejected due to invalid form", {
				errors,
			});
			return redirect("/auth/forgot?error=invalid_form");
		}

		// Trim email to ensure consistency with Supabase Auth. This cannot be enforced at the
		// database level because Supabase Auth stores emails in its own auth.users table which
		// doesn't have our whitespace constraint. Trimming prevents authentication mismatches
		// when users request password resets with emails that have leading/trailing whitespace.
		const email = parsed.data.email.trim();
		const captchaToken = parsed.data.captcha_token;

		const redirectTo = new URL("/auth/recover", getSiteUrl()).toString();

		const { error } = await supabase.auth.resetPasswordForEmail(email, {
			redirectTo,
			captchaToken,
		});

		if (error) {
			if (error.code === "captcha_failed") {
				return redirect("/auth/forgot?error=captcha_required");
			}

			// Supabase Auth returns status 429 for rate limits. Error codes include:
			// - "over_request_rate_limit" - too many auth requests
			// - "over_email_send_rate_limit" - too many email-sending operations
			// Password reset requests are rate-limited per user (default 60 seconds between requests).
			if (
				error.status === 429 ||
				error.code === "over_request_rate_limit" ||
				error.code === "over_email_send_rate_limit"
			) {
				// Attempt to extract retry seconds from error message.
				// Supabase Auth errors don't expose Retry-After header, so we parse the message.
				const seconds =
					parseRateLimitSeconds(error.message) ??
					DEFAULT_PASSWORD_RESET_RATE_LIMIT_SECONDS;

				return redirect(`/auth/forgot?error=rate_limit&seconds=${seconds}`);
			}

			logger.error("Password reset request failed", {}, error);
			return redirect("/auth/forgot?error=failed");
		}

		return redirect("/auth/forgot?success=true");
	} catch (error) {
		logger.error("Password reset request failed", undefined, error);
		return redirect("/auth/forgot?error=failed");
	}
};
