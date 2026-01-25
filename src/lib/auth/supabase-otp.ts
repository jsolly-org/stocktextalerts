import type { AppSupabaseClient } from "../db/supabase";

export type SupabaseEmailOtpType =
	| "email"
	| "invite"
	| "magiclink"
	| "recovery"
	| "email_change";

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

export async function verifySupabaseOtp(
	supabase: AppSupabaseClient,
	params: VerifyOtpParams,
): Promise<VerifyOtpResult> {
	// `@supabase/auth-js` is a transitive dependency and our TS tooling sometimes
	// fails to resolve its method surface correctly. We keep the runtime call but
	// type the minimal shape we actually use in the app.
	const auth = supabase.auth as unknown as {
		verifyOtp: (p: VerifyOtpParams) => Promise<VerifyOtpResult>;
	};

	return auth.verifyOtp(params);
}
