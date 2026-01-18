import type { APIRoute } from "astro";
import { parseWithSchema } from "../../../lib/forms/parsing";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/supabase";

const MIN_PASSWORD_LENGTH = 8;

function buildRecoverRedirect(
	error: string,
	token?: string | null,
	type?: string | null,
) {
	const params = new URLSearchParams({ error });
	if (token) {
		params.set("token", token);
	}
	if (type) {
		params.set("type", type);
	}
	return `/auth/recover?${params.toString()}`;
}

export const POST: APIRoute = async ({ request, redirect }) => {
	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		password: { type: "string", required: true, trim: false },
		confirm: { type: "string", required: true, trim: false },
		token: { type: "string", required: true },
		type: { type: "string", required: true },
	} as const);

	if (!parsed.ok) {
		console.error("Password reset rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect(buildRecoverRedirect("invalid_form"), 303);
	}

	const { password, confirm, token, type } = parsed.data;

	if (password !== confirm) {
		console.error("Password reset rejected: password mismatch", {
			tokenProvided: !!token,
			type,
		});
		return redirect(
			buildRecoverRedirect("password_mismatch", token, type),
			303,
		);
	}

	if (type !== "recovery") {
		console.error("Password reset rejected: invalid type", {
			type,
			tokenProvided: !!token,
		});
		return redirect(buildRecoverRedirect("invalid_token", token, type), 303);
	}

	// Validate password strength before consuming the token
	// This prevents token consumption if password is obviously too weak
	// Note: This is a basic length check. Supabase may enforce additional
	// complexity rules (e.g., mixed case, special characters) that could cause
	// updateUserById to fail with weak_password after the token is consumed.
	// See supabase/config.toml for the configured password policy.
	if (password.length < MIN_PASSWORD_LENGTH) {
		console.error("Password reset rejected: password too short", {
			passwordLength: password.length,
			minLength: MIN_PASSWORD_LENGTH,
			tokenProvided: !!token,
		});
		return redirect(buildRecoverRedirect("weak_password", token, type), 303);
	}

	const supabase = createSupabaseServerClient();

	const { data, error } = await supabase.auth.verifyOtp({
		token_hash: token,
		type: "recovery",
	});

	if (error || !data.user) {
		const errorCode = error?.code ?? "unknown";
		console.error("Password reset token verification failed", {
			error: error?.message ?? "unknown_error",
			errorCode,
		});

		if (errorCode === "otp_expired") {
			return redirect(buildRecoverRedirect("expired", token, type), 303);
		}

		return redirect(buildRecoverRedirect("invalid_token", token, type), 303);
	}

	const adminClient = createSupabaseAdminClient();
	const { error: updateError } = await adminClient.auth.admin.updateUserById(
		data.user.id,
		{
			password,
		},
	);

	if (updateError) {
		console.error("Password update failed", {
			error: updateError.message,
			errorCode: updateError.code,
		});

		// If update fails with weak_password, the token is already consumed
		// We redirect without the token since it can't be reused
		if (updateError.code === "weak_password") {
			return redirect(
				buildRecoverRedirect("weak_password", undefined, type),
				303,
			);
		}

		return redirect(
			buildRecoverRedirect("update_failed", undefined, type),
			303,
		);
	}

	return redirect("/signin?success=password_reset", 303);
};
