import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/generated/database.types";
import { rootLogger } from "../../logging";

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

/**
 * Release a previously-claimed idempotency key so a failed/aborted dispatch can
 * be retried. Best-effort: a failure to release is logged but not thrown (the
 * caller is already returning an error path).
 */
export async function releaseEmailDispatchKey(
	supabase: AdminClient,
	idempotencyKey: string,
): Promise<void> {
	const { error } = await supabase
		.from("email_dispatch_idempotency")
		.delete()
		.eq("idempotency_key", idempotencyKey);
	if (error) {
		rootLogger.warn("Failed to release email dispatch idempotency key", {
			action: "email_dispatch_release",
			error: error.message,
		});
	}
}
