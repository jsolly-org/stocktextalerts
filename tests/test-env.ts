import { createClient } from "@supabase/supabase-js";

type TestEnv = {
	supabaseUrl: string;
	supabaseServiceRoleKey: string;
	supabaseAnonKey: string;
};

function getTestEnv(): TestEnv {
	const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
	const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const supabaseAnonKey = process.env.PUBLIC_SUPABASE_ANON_KEY;

	// Tests run outside the request pipeline, so middleware env validation doesn't apply.
	if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
		throw new Error(
			"Missing required environment variables for tests: PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and PUBLIC_SUPABASE_ANON_KEY must be set",
		);
	}

	return { supabaseUrl, supabaseServiceRoleKey, supabaseAnonKey };
}

const testEnv = getTestEnv();

export const adminClient = createClient(
	testEnv.supabaseUrl,
	testEnv.supabaseServiceRoleKey,
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
	const supabase = createClient(testEnv.supabaseUrl, testEnv.supabaseAnonKey, {
		auth: {
			autoRefreshToken: false,
			persistSession: false,
		},
	});

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
