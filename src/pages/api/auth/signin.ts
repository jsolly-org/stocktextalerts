import type { APIRoute } from "astro";
import { setAuthCookies } from "../../../lib/auth/cookies";
import {
	buildSigninRedirectUrl,
	getPostSigninRedirect,
	getSafeRedirectPath,
} from "../../../lib/auth/redirects";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";

function buildSigninErrorRedirect(
	errorCode: string,
	{
		email,
		redirectPath,
	}: {
		email?: string;
		redirectPath?: string | null;
	},
): string {
	const url = new URL(
		buildSigninRedirectUrl(redirectPath ?? null),
		"http://internal",
	);
	url.searchParams.set("error", errorCode);
	if (email) {
		url.searchParams.set("email", email);
	}
	return `${url.pathname}${url.search}`;
}

export const POST: APIRoute = async ({
	request,
	cookies,
	redirect,
	locals,
}) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();

	const formData = await request.formData();
	const redirectParam = formData.get("redirect");
	const redirectPath = getSafeRedirectPath(
		typeof redirectParam === "string" ? redirectParam : null,
	);
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
		password: { type: "string", required: true, trim: false },
	} as const);

	if (!parsed.ok) {
		logger.info("Sign-in attempt rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		const email = formData.get("email");
		const emailParam = typeof email === "string" ? email : undefined;
		return redirect(
			buildSigninErrorRedirect("invalid_form", {
				email: emailParam,
				redirectPath,
			}),
		);
	}

	const email = parsed.data.email.trim();
	const password = parsed.data.password;

	const { data, error } = await supabase.auth.signInWithPassword({
		email,
		password,
	});

	if (error) {
		if (error.code === "email_not_confirmed") {
			logger.info("Sign-in blocked due to unconfirmed email", { email });
			return redirect(`/auth/unconfirmed?email=${encodeURIComponent(email)}`);
		}

		const shouldLogError =
			typeof error.status === "number" && error.status >= 500;
		if (shouldLogError) {
			logger.error(
				"Sign-in failed",
				{ code: error.code, status: error.status },
				error,
			);
		} else {
			logger.info("Sign-in failed", {
				code: error.code,
				status: error.status,
			});
		}

		return redirect(
			buildSigninErrorRedirect("invalid_credentials", {
				email,
				redirectPath,
			}),
		);
	}

	if (!data.session) {
		logger.error("Sign-in succeeded but no session was returned", {
			email,
			reason: "missing_session",
		});
		return redirect(
			buildSigninErrorRedirect("no_session", {
				email,
				redirectPath,
			}),
		);
	}

	const { access_token, refresh_token } = data.session;
	setAuthCookies(cookies, access_token, refresh_token);
	return redirect(getPostSigninRedirect(redirectPath));
};
