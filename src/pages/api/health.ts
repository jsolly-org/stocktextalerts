import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { rootLogger } from "../../lib/logging";

export const prerender = false;

/**
 * Lightweight readiness probe. Pings Postgres via a cheap count against
 * app_metadata (a tiny, always-present key/value table). Returns 503 if the DB
 * is unreachable so synthetic monitoring can detect a Supabase outage instead of
 * waiting for a user to hit an authenticated page.
 */
export async function GET(): Promise<Response> {
	let db: "ok" | "error" = "ok";
	try {
		const { error } = await createSupabaseAdminClient()
			.from("app_metadata")
			.select("key", { head: true, count: "exact" });
		if (error) db = "error";
	} catch (error) {
		db = "error";
		rootLogger.warn("Health check DB ping failed", { action: "health_check" }, error);
	}

	const status = db === "ok" ? "ok" : "degraded";
	return new Response(JSON.stringify({ status, checks: { db } }), {
		status: db === "ok" ? 200 : 503,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}
