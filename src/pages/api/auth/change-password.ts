import type { APIRoute } from "astro";
import { MIN_PASSWORD_LENGTH } from "../../../lib/constants";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";

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
