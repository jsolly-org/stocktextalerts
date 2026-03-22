import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readEnv } from "./env";
import type { Database } from "./generated/database.types";

const supabaseUrl = readEnv("SUPABASE_URL") as string;
const supabasePublishableKey = readEnv("SUPABASE_PUBLISHABLE_KEY") as string;
const supabaseSecretKey = readEnv("SUPABASE_SECRET_KEY") as string;

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
	return createClient<Database>(supabaseUrl, key, SUPABASE_CLIENT_OPTIONS);
}

/**
 * Create a Supabase client configured for server-side usage (publishable key).
 *
 * Auth session persistence/refresh is disabled because Astro routes manage cookies explicitly.
 */
export function createSupabaseServerClient(): AppSupabaseClient {
	return createTypedClient(supabasePublishableKey);
}

/**
 * Create a Supabase client configured for privileged server-side operations (secret key).
 *
 * Only use this in server environments; never ship the secret key to the browser.
 */
export function createSupabaseAdminClient(): AppSupabaseClient {
	return createTypedClient(supabaseSecretKey);
}
