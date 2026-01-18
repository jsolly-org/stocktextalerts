import type { APIRoute } from "astro";
import { getSiteUrl } from "../../../../lib/env";
import { parseWithSchema } from "../../../../lib/forms/parsing";
import { createSupabaseServerClient } from "../../../../lib/supabase";

/*
 * Regex pattern to extract seconds from Supabase Auth rate limit error messages.
 *
 * Supabase Auth rate limit errors (status 429 or code "rate_limit_exceeded") include
 * a message with the remaining wait time in the format: "N seconds" or "N second".
 * Example: "Please try again in 60 seconds" or "Rate limit exceeded. Try again in 120 seconds"
 *
 * This pattern matches one or more digits followed by optional whitespace and "second" or "seconds".
 */
const RATE_LIMIT_SECONDS_PATTERN = /(\d+)\s+seconds?/;

export const POST: APIRoute = async ({ request, redirect }) => {
	const supabase = createSupabaseServerClient();

	try {
		const formData = await request.formData();
		const parsed = parseWithSchema(formData, {
			email: { type: "string", required: true },
			captcha_token: { type: "string", required: true },
		} as const);

		if (!parsed.ok) {
			const errors = parsed.allErrors;
			console.error("Password reset request rejected due to invalid form", {
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
			console.error("Password reset request failed:", error);

			if (error.code === "captcha_failed") {
				return redirect("/auth/forgot?error=captcha_required");
			}

			if (error.status === 429 || error.code === "rate_limit_exceeded") {
				const seconds = error.message?.match(RATE_LIMIT_SECONDS_PATTERN)?.[1];
				if (seconds) {
					return redirect(`/auth/forgot?error=rate_limit&seconds=${seconds}`);
				}
				return redirect("/auth/forgot?error=rate_limit");
			}

			return redirect("/auth/forgot?error=failed");
		}

		return redirect("/auth/forgot?success=true");
	} catch (error) {
		console.error("Password reset request failed:", error);
		return redirect("/auth/forgot?error=failed");
	}
};
