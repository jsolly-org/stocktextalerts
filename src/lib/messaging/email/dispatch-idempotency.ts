import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/generated/database.types";
import { rootLogger } from "../../logging";

type AdminClient = SupabaseClient<Database>;

type DispatchClaimResult = "claimed" | "duplicate";

/**
 * Atomically claim an email-dispatch idempotency key. Returns "claimed" the
 * first time a key is seen and "duplicate" while a live claim exists — durable
 * across Lambda cold starts and concurrent instances, unlike the previous
 * in-memory map.
 *
 * The `claim_email_dispatch_key` RPC RE-CLAIMS an expired key (TTL lapsed), so a
 * claim that the dispatcher deliberately kept on an ambiguous SES outcome self-heals
 * after the window instead of suppressing a legitimate later retry forever.
 */
export async function claimEmailDispatchKey(
	supabase: AdminClient,
	idempotencyKey: string,
): Promise<DispatchClaimResult> {
	const { data, error } = await supabase.rpc("claim_email_dispatch_key", {
		p_key: idempotencyKey,
	});

	if (error) throw error;
	return data ? "claimed" : "duplicate";
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
