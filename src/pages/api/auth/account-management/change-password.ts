import {
	CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS,
	CHANGE_PASSWORD_RATE_LIMIT_MINUTES,
} from "astro:env/server";
import type { APIRoute } from "astro";
import { enforceAuthRateLimit } from "../../../../lib/auth/enforce-rate-limit";
import { MIN_PASSWORD_LENGTH } from "../../../../lib/constants";
import { createUserService } from "../../../../lib/db";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

/*
 * Rate limit: N attempts per user per time window.
 * Override via CHANGE_PASSWORD_RATE_LIMIT_* in env (see astro.config.ts env.schema).
 */
export const POST: APIRoute = async ({ url, request, redirect, locals, cookies }) => {
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
	} as const);

	if (!parsed.ok) {
		logger.info("Password change request rejected due to invalid form", {
			userId: authUser.id,
			errors: parsed.allErrors,
		});
		return redirect("/profile?error=invalid_form");
	}

	const { password } = parsed.data;

	if (password.length < MIN_PASSWORD_LENGTH) {
		logger.info("Password change request rejected due to weak password", {
			userId: authUser.id,
			passwordLength: password.length,
			minLength: MIN_PASSWORD_LENGTH,
		});
		return redirect("/profile?error=weak_password");
	}

	const adminSupabase = createSupabaseAdminClient();
	const rateLimitRedirect = await enforceAuthRateLimit({
		adminSupabase,
		userId: authUser.id,
		endpoint: "change_password",
		maxRequests: CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS,
		windowMinutes: CHANGE_PASSWORD_RATE_LIMIT_MINUTES,
		logger,
		contextLabel: "password change",
	});
	if (rateLimitRedirect) return rateLimitRedirect;

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
