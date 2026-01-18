import type { APIRoute } from "astro";
import { setAuthCookies } from "../../../lib/auth-cookies";
import { parseWithSchema } from "../../../lib/forms/parsing";
import { createSupabaseServerClient } from "../../../lib/supabase";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	const supabase = createSupabaseServerClient();

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
		password: { type: "string", required: true, trim: false },
		captcha_token: { type: "string", required: true },
	} as const);

	if (!parsed.ok) {
		console.error("Sign-in attempt rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		const email = formData.get("email");
		const emailParam =
			typeof email === "string" ? `&email=${encodeURIComponent(email)}` : "";
		return redirect(`/signin?error=invalid_form${emailParam}`);
	}

	// Trim email to ensure consistency with Supabase Auth. This cannot be enforced at the
	// database level because Supabase Auth stores emails in its own auth.users table which
	// doesn't have our whitespace constraint. Trimming prevents authentication mismatches
	// when users sign in with emails that have leading/trailing whitespace.
	const email = parsed.data.email.trim();
	const password = parsed.data.password;
	const captchaToken = parsed.data.captcha_token;

	const { data, error } = await supabase.auth.signInWithPassword({
		email,
		password,
		options: {
			captchaToken,
		},
	});

	if (error) {
		if (error.code === "captcha_failed") {
			console.error("Sign-in blocked due to captcha", {
				code: error.code,
				status: error.status,
			});
			return redirect(
				`/signin?error=captcha_required&email=${encodeURIComponent(email)}`,
			);
		}

		if (error.code === "email_not_confirmed") {
			console.error("Sign-in blocked due to unconfirmed email", {
				email,
			});
			return redirect(`/auth/unconfirmed?email=${encodeURIComponent(email)}`);
		}

		console.error("Sign-in failed", {
			email,
			message: error.message,
		});

		return redirect(
			`/signin?error=invalid_credentials&email=${encodeURIComponent(email)}`,
		);
	}

	if (!data.session) {
		console.error("Sign-in succeeded but no session was returned", { email });
		return redirect(
			`/signin?error=no_session&email=${encodeURIComponent(email)}`,
		);
	}

	const { access_token, refresh_token } = data.session;
	setAuthCookies(cookies, access_token, refresh_token);
	return redirect("/dashboard");
};
