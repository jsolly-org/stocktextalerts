import { createClient } from "@supabase/supabase-js";

type TestEnv = {
	supabaseUrl: string;
	supabaseSecretKey: string;
	supabasePublishableKey: string;
};

function getTestEnv(): TestEnv {
	const supabaseUrl = process.env.SUPABASE_URL;
	const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
	const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

	// Tests run outside the request pipeline, so middleware env validation doesn't apply.
	return {
		supabaseUrl: supabaseUrl as string,
		supabaseSecretKey: supabaseSecretKey as string,
		supabasePublishableKey: supabasePublishableKey as string,
	};
}

const testEnv = getTestEnv();

export const adminClient = createClient(
	testEnv.supabaseUrl,
	testEnv.supabaseSecretKey,
	{
		auth: {
			autoRefreshToken: false,
			persistSession: false,
		},
	},
);

export async function createAuthenticatedCookies(
	email: string,
	password: string,
): Promise<Map<string, string>> {
	const supabase = createClient(
		testEnv.supabaseUrl,
		testEnv.supabasePublishableKey,
		{
			auth: {
				autoRefreshToken: false,
				persistSession: false,
			},
		},
	);

	const { data, error } = await supabase.auth.signInWithPassword({
		email,
		password,
	});

	if (error || !data.session) {
		throw new Error(`Failed to sign in: ${error?.message || "Unknown error"}`);
	}

	const cookies = new Map<string, string>();
	cookies.set("sb-access-token", data.session.access_token);
	cookies.set("sb-refresh-token", data.session.refresh_token);

	return cookies;
}
