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
 * Rate limit: N change-password attempts per user per time window.
 * Reduces brute-force risk when an attacker has a stolen session.
 * Can be overridden via CHANGE_PASSWORD_RATE_LIMIT_* env vars.
 */
const parsedRateLimitRequests = Number.parseInt(
	import.meta.env.CHANGE_PASSWORD_RATE_LIMIT_REQUESTS ?? "5",
	10,
);
const CHANGE_PASSWORD_RATE_LIMIT_REQUESTS =
	Number.isFinite(parsedRateLimitRequests) && parsedRateLimitRequests > 0
		? parsedRateLimitRequests
		: 5;

const parsedRateLimitMinutes = Number.parseInt(
	import.meta.env.CHANGE_PASSWORD_RATE_LIMIT_MINUTES ?? "15",
	10,
);
const CHANGE_PASSWORD_RATE_LIMIT_MINUTES =
	Number.isFinite(parsedRateLimitMinutes) && parsedRateLimitMinutes > 0
		? parsedRateLimitMinutes
		: 15;
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

	// Rate limit only valid-looking attempts; invalid forms never consume a slot
	const adminSupabase = createSupabaseAdminClient();
	const { data: rateLimitAllowed, error: rateLimitError } =
		await adminSupabase.rpc("check_rate_limit", {
			p_user_id: authUser.id,
			p_endpoint: "change_password",
			p_max_requests: CHANGE_PASSWORD_RATE_LIMIT_REQUESTS,
			p_window_minutes: CHANGE_PASSWORD_RATE_LIMIT_MINUTES,
		});

	if (rateLimitError) {
		logger.error(
			"Rate limit check failed for change-password",
			{ userId: authUser.id },
			rateLimitError,
		);
		return redirect("/profile?error=server_error");
	}

	if (rateLimitAllowed === false) {
		logger.info("User rate-limited for change-password attempts", {
			userId: authUser.id,
		});
		return redirect("/profile?error=rate_limit");
	}

	if (rateLimitAllowed !== true) {
		logger.error("Change-password rate limit check returned unexpected value", {
			userId: authUser.id,
			rateLimitAllowed,
		});
		return redirect("/profile?error=server_error");
	}

	const { error } = await supabase.auth.updateUser({ password });
	if (error) {
		if (error.code === "weak_password") {
			logger.info("Password change request rejected due to weak password", {
				userId: authUser.id,
				passwordLength: password.length,
				minLength: MIN_PASSWORD_LENGTH,
			});
			return redirect("/profile?error=weak_password");
		}
		logger.error(
			"Password change request failed",
			{
				userId: authUser.id,
				errorCode: error.code,
				errorStatus: error.status,
			},
			error,
		);
		return redirect("/profile?error=password_change_failed");
	}

	return redirect("/profile?success=password_changed");
};
