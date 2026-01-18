import type { APIRoute } from "astro";
import { getSiteUrl } from "../../../../lib/env";
import { parseWithSchema } from "../../../../lib/forms/parsing";
import { createSupabaseServerClient } from "../../../../lib/supabase";

export const POST: APIRoute = async ({ request, redirect }) => {
	const supabase = createSupabaseServerClient();

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
		captcha_token: { type: "string", required: true },
	} as const);

	if (!parsed.ok) {
		console.error("Resend verification request rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/auth/unconfirmed?error=invalid_form");
	}

	// Trim email to ensure consistency with Supabase Auth. This cannot be enforced at the
	// database level because Supabase Auth stores emails in its own auth.users table which
	// doesn't have our whitespace constraint. Trimming prevents authentication mismatches
	// when users request verification resends with emails that have leading/trailing whitespace.
	const email = parsed.data.email.trim();
	const captchaToken = parsed.data.captcha_token;

	if (/\s/.test(email)) {
		console.error("Resend verification rejected: email contains whitespace", {
			email,
		});
		return redirect("/auth/unconfirmed?error=invalid_form");
	}

	const origin = getSiteUrl();
	const emailRedirectTo = `${origin}/auth/verified`;

	const { error } = await supabase.auth.resend({
		type: "signup",
		email,
		options: {
			emailRedirectTo,
			captchaToken,
		},
	});

	if (error) {
		if (error.code === "captcha_failed") {
			console.error("Resend verification blocked due to captcha", {
				code: error.code,
				status: error.status,
			});
			return redirect(
				`/auth/unconfirmed?email=${encodeURIComponent(email)}&error=captcha_required`,
			);
		}

		console.error("Resend verification email failed:", error);
		return redirect(
			`/auth/unconfirmed?email=${encodeURIComponent(email)}&error=failed`,
		);
	}

	return redirect(
		`/auth/unconfirmed?email=${encodeURIComponent(email)}&success=true`,
	);
};
