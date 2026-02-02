import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./generated/database.types";

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
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

export function createSupabaseServerClient(): AppSupabaseClient {
	return createClient<Database>(
		supabaseUrl,
		supabaseAnonKey,
		SUPABASE_CLIENT_OPTIONS,
	);
}

export function createSupabaseAdminClient(): AppSupabaseClient {
	return createClient<Database>(
		supabaseUrl,
		supabaseSecretKey,
		SUPABASE_CLIENT_OPTIONS,
	);
}
