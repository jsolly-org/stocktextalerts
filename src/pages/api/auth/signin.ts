import type { APIRoute } from "astro";
import { isUserApproved } from "../../../lib/auth/approval/status";
import {
	buildSigninRedirectUrl,
	getPostSigninRedirect,
	getSafeRedirectPath,
} from "../../../lib/auth/redirects";
import { setAuthCookies } from "../../../lib/auth/session/cookies";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../lib/db/supabase";
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
	const url = new URL(buildSigninRedirectUrl(redirectPath ?? null), "http://internal");
	url.searchParams.set("error", errorCode);
	if (email) {
		url.searchParams.set("email", email);
	}
	return `${url.pathname}${url.search}`;
}

export const POST: APIRoute = async ({ url, request, cookies, redirect, locals }) => {
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

		const shouldLogError = typeof error.status === "number" && error.status >= 500;
		if (shouldLogError) {
			logger.error("Sign-in failed", { code: error.code, status: error.status }, error);
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

	const adminSupabase = createSupabaseAdminClient();
	const { data: dbUser, error: dbUserError } = await adminSupabase
		.from("users")
		.select("approved_at")
		.eq("id", data.user.id)
		.maybeSingle();
	if (dbUserError) {
		logger.error("Sign-in approval lookup failed", { userId: data.user.id }, dbUserError);
		return redirect(buildSigninErrorRedirect("failed", { email, redirectPath }));
	}
	if (!dbUser || !isUserApproved(dbUser)) {
		logger.info("Sign-in redirected for pending approval", { userId: data.user.id });
		return redirect("/auth/pending-approval");
	}

	return redirect(getPostSigninRedirect(redirectPath));
};
