import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";
import type { Database } from "./generated/database.types";

// SUPABASE_URL / SUPABASE_SECRET_KEY are read lazily (inside the factories
// below), NOT at module load. In the Lambda runtime these come from SSM via
// `loadSecretsIntoEnv`, which runs inside the handler body — after this module
// has already been imported. A module-level read would fire before the secret
// is in `process.env` and throw. Point-of-use reads also match this codebase's
// env convention (see env.ts).

const SUPABASE_CLIENT_OPTIONS = {
	auth: {
		autoRefreshToken: false,
		persistSession: false,
	},
	global: {
		headers: {
			"Cache-Control": "no-cache, no-store, must-revalidate",
		},
	},
};

export type AppSupabaseClient = SupabaseClient<Database>;

function createTypedClient(key: string): AppSupabaseClient {
	return createClient<Database>(requireEnv("SUPABASE_URL"), key, SUPABASE_CLIENT_OPTIONS);
}

/**
 * Create a Supabase client configured for server-side usage (publishable key).
 *
 * Auth session persistence/refresh is disabled because Astro routes manage cookies explicitly.
 */
export function createSupabaseServerClient(): AppSupabaseClient {
	return createTypedClient(requireEnv("SUPABASE_PUBLISHABLE_KEY"));
}

/**
 * Create a Supabase client configured for privileged server-side operations (secret key).
 *
 * Only use this in server environments; never ship the secret key to the browser.
 */
export function createSupabaseAdminClient(): AppSupabaseClient {
	return createTypedClient(requireEnv("SUPABASE_SECRET_KEY"));
}
