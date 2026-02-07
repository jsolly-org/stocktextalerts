import type { APIRoute } from "astro";
import { getSiteUrl } from "../../../../lib/db/env";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

/*
 * Wait time for password reset rate limits.
 * Supabase defaults to 60 seconds between password reset requests for the same email.
 * Can be overridden via PASSWORD_RESET_RATE_LIMIT_SECONDS env var.
 */
const PASSWORD_RESET_RATE_LIMIT_SECONDS =
	Number.parseInt(
		import.meta.env.PASSWORD_RESET_RATE_LIMIT_SECONDS ?? "60",
		10,
	) || 60;

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
		} as const);

		if (!parsed.ok) {
			const errors = parsed.allErrors;
			logger.info("Password reset request rejected due to invalid form", {
				errors,
			});
			return redirect("/auth/forgot?error=invalid_form");
		}

		const email = parsed.data.email.trim();

		const redirectTo = new URL(
			"/auth/recover?type=recovery",
			getSiteUrl(),
		).toString();

		const { error } = await supabase.auth.resetPasswordForEmail(email, {
			redirectTo,
		});

		if (error) {
			// Supabase Auth returns status 429 for rate limits. Error codes include:
			// - "over_request_rate_limit" - too many auth requests
			// - "over_email_send_rate_limit" - too many email-sending operations
			// Password reset requests are rate-limited per user (default 60 seconds between requests).
			if (
				error.status === 429 ||
				error.code === "over_request_rate_limit" ||
				error.code === "over_email_send_rate_limit"
			) {
				// Expected rejection (rate limit); info to avoid inflating error metrics.
				logger.info("Password reset rate limit hit", {
					email,
					errorCode: error.code,
					errorStatus: error.status,
				});
				return redirect(
					`/auth/forgot?error=rate_limit&seconds=${PASSWORD_RESET_RATE_LIMIT_SECONDS}`,
				);
			}

			logger.error(
				"Password reset request failed",
				{
					email,
					errorCode: error.code,
					errorStatus: error.status,
				},
				error,
			);
			return redirect("/auth/forgot?error=failed");
		}

		return redirect("/auth/forgot?success=true");
	} catch (error) {
		logger.error(
			"Password reset request failed",
			{ reason: "password_reset_exception" },
			error,
		);
		return redirect("/auth/forgot?error=failed");
	}
};
