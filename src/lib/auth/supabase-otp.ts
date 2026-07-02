import type { AppSupabaseClient } from "../db/supabase";

export type SupabaseEmailOtpType = "email" | "invite" | "magiclink" | "recovery" | "email_change";

type VerifyOtpParams = {
	token_hash: string;
	type: SupabaseEmailOtpType;
};

type VerifyOtpUser = {
	id: string;
	email_confirmed_at?: string | null;
};

type VerifyOtpResult = {
	data: { user: VerifyOtpUser | null };
	error: { code?: string; message: string } | null;
};

/**
 * Verify a Supabase email OTP token hash for the given OTP type.
 *
 * Narrows the auth surface to the minimal OTP shape the app uses.
 */
export async function verifySupabaseOtp(
	supabase: AppSupabaseClient,
	params: VerifyOtpParams,
): Promise<VerifyOtpResult> {
	return supabase.auth.verifyOtp(params);
}

/** True when Supabase reports a single-use OTP was already consumed or expired. */
export function isConsumedEmailOtpError(
	error: { code?: string; message: string } | null | undefined,
): boolean {
	if (!error) return false;
	const code = error.code ?? "";
	if (code === "otp_expired" || code === "otp_disabled") {
		return true;
	}
	const message = error.message.toLowerCase();
	return (
		message.includes("expired") ||
		message.includes("already been used") ||
		message.includes("non-error thrown")
	);
}
