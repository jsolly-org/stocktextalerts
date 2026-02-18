import type { APIRoute } from "astro";
import { MIN_PASSWORD_LENGTH } from "../../../lib/constants";
import { createUserService } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";

/*
 * Rate limit: N attempts per user per time window.
 * Can be overridden via CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS and
 * CHANGE_PASSWORD_RATE_LIMIT_MINUTES env vars.
 */
const CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS =
	Number.parseInt(
		import.meta.env.CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS ?? "5",
		10,
	) || 5;
const CHANGE_PASSWORD_RATE_LIMIT_MINUTES =
	Number.parseInt(
		import.meta.env.CHANGE_PASSWORD_RATE_LIMIT_MINUTES ?? "15",
		10,
	) || 15;

export const POST: APIRoute = async ({
	request,
	redirect,
	locals,
	cookies,
}) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);
	const authUser = await users.getCurrentUser();

	if (!authUser) {
		logger.info("Password change requested without authenticated user", {
			reason: "unauthenticated",
		});
		return redirect("/auth/signin?error=unauthorized");
	}

	const adminSupabase = createSupabaseAdminClient();
	const { data: rateLimitAllowed, error: rateLimitError } =
		await adminSupabase.rpc("check_rate_limit", {
			p_user_id: authUser.id,
			p_endpoint: "change_password",
			p_max_requests: CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS,
			p_window_minutes: CHANGE_PASSWORD_RATE_LIMIT_MINUTES,
		});

	if (rateLimitError) {
		logger.error(
			"Rate limit check failed for password change",
			{ userId: authUser.id },
			rateLimitError,
		);
		return redirect("/profile?error=failed");
	}

	if (rateLimitAllowed === false) {
		logger.info("User rate-limited for password change attempts", {
			userId: authUser.id,
		});
		return redirect(
			`/profile?error=rate_limit&minutes=${CHANGE_PASSWORD_RATE_LIMIT_MINUTES}`,
		);
	}

	if (rateLimitAllowed !== true) {
		logger.error("Password change rate limit check returned unexpected value", {
			userId: authUser.id,
			rateLimitAllowed,
		});
		return redirect("/profile?error=failed");
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		password: { type: "string", required: true, trim: false },
		confirm: { type: "string", required: true, trim: false },
	} as const);

	if (!parsed.ok) {
		logger.info("Password change request rejected due to invalid form", {
			userId: authUser.id,
			errors: parsed.allErrors,
		});
		return redirect("/profile?error=invalid_form");
	}

	const { password, confirm } = parsed.data;
	if (password !== confirm) {
		logger.info("Password change request rejected due to password mismatch", {
			userId: authUser.id,
		});
		return redirect("/profile?error=password_mismatch");
	}

	if (password.length < MIN_PASSWORD_LENGTH) {
		logger.info("Password change request rejected due to weak password", {
			userId: authUser.id,
			passwordLength: password.length,
			minLength: MIN_PASSWORD_LENGTH,
		});
		return redirect("/profile?error=weak_password");
	}

	const { error } = await supabase.auth.updateUser({ password });
	if (error) {
		logger.error(
			"Password change request failed",
			{
				userId: authUser.id,
				errorCode: error.code,
				errorStatus: error.status,
			},
			error,
		);
		if (error.code === "weak_password") {
			return redirect("/profile?error=weak_password");
		}
		return redirect("/profile?error=password_change_failed");
	}

	return redirect("/profile?success=password_changed");
};
