import type { APIRoute } from "astro";
import { verifySupabaseOtp } from "../../../lib/auth/supabase-otp";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";

const MIN_PASSWORD_LENGTH = 8;

function buildRecoverRedirect(error: string, tokenHash?: string | null) {
	const params = new URLSearchParams({ error, type: "recovery" });
	if (tokenHash) {
		params.set("token_hash", tokenHash);
	}
	return `/auth/recover?${params.toString()}`;
}

export const POST: APIRoute = async ({ request, redirect, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		password: { type: "string", required: true, trim: false },
		confirm: { type: "string", required: true, trim: false },
		token_hash: { type: "string", required: true },
	} as const);

	if (!parsed.ok) {
		logger.info("Password reset rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect(buildRecoverRedirect("invalid_form"), 303);
	}

	const { password, confirm, token_hash: tokenHash } = parsed.data;

	if (password !== confirm) {
		logger.info("Password reset rejected: password mismatch", {
			tokenProvided: !!tokenHash,
		});
		return redirect(buildRecoverRedirect("password_mismatch", tokenHash), 303);
	}

	// Validate password strength before consuming the token
	// This prevents token consumption if password is obviously too weak
	// Note: This is a basic length check. Supabase may enforce additional
	// complexity rules (e.g., mixed case, special characters) that could cause
	// updateUserById to fail with weak_password after the token is consumed.
	// See supabase/config.toml for the configured password policy.
	if (password.length < MIN_PASSWORD_LENGTH) {
		logger.info("Password reset rejected: password too short", {
			passwordLength: password.length,
			minLength: MIN_PASSWORD_LENGTH,
			tokenProvided: !!tokenHash,
		});
		return redirect(buildRecoverRedirect("weak_password", tokenHash), 303);
	}

	const supabase = createSupabaseServerClient();

	const { data, error } = await verifySupabaseOtp(supabase, {
		token_hash: tokenHash,
		type: "recovery",
	});

	if (error || !data.user) {
		const errorCode = error?.code ?? "unknown";
		// Expected rejection (expired/invalid token, old links, etc.); info to avoid inflating error metrics.
		logger.info("Password reset token verification failed", {
			error: error?.message ?? "unknown_error",
			errorCode,
		});

		if (errorCode === "otp_expired") {
			return redirect(buildRecoverRedirect("expired", tokenHash), 303);
		}

		return redirect(buildRecoverRedirect("invalid_token", tokenHash), 303);
	}

	const adminClient = createSupabaseAdminClient();
	const { error: updateError } = await adminClient.auth.admin.updateUserById(
		data.user.id,
		{
			password,
		},
	);

	if (updateError) {
		logger.error("Password update failed", {
			error: updateError.message,
			errorCode: updateError.code,
		});

		// If update fails with weak_password, the token is already consumed
		// We redirect without the token since it can't be reused
		if (updateError.code === "weak_password") {
			return redirect(buildRecoverRedirect("weak_password"), 303);
		}

		return redirect(buildRecoverRedirect("update_failed"), 303);
	}

	return redirect("/signin?success=password_reset", 303);
};
