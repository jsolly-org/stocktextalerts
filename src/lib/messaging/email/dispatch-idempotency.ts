import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/generated/database.types";

type AdminClient = SupabaseClient<Database>;

type DispatchClaimResult = "claimed" | "duplicate";

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Atomically claim an email-dispatch idempotency key. Returns "claimed" the
 * first time a key is seen and "duplicate" on any subsequent attempt — durable
 * across Lambda cold starts and concurrent instances, unlike the previous
 * in-memory map.
 */
export async function claimEmailDispatchKey(
	supabase: AdminClient,
	idempotencyKey: string,
): Promise<DispatchClaimResult> {
	const { error } = await supabase
		.from("email_dispatch_idempotency")
		.insert({ idempotency_key: idempotencyKey });

	if (!error) return "claimed";
	if (error.code === UNIQUE_VIOLATION) return "duplicate";
	throw error;
}
