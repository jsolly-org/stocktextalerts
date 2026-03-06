import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./generated/database.types";

const supabaseUrl = import.meta.env.SUPABASE_URL;
const supabasePublishableKey = import.meta.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseSecretKey = import.meta.env.SUPABASE_SECRET_KEY;

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
