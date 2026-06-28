import { createSupabaseAdminClient } from "../../src/lib/db/supabase";
import { rootLogger } from "../../src/lib/logging";

/**
 * Lightweight DB readiness probe for the test suite. Pings Postgres via a
 * cheap count against app_metadata (a tiny, always-present key/value table).
 */
export async function checkDatabaseHealth(): Promise<Response> {
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
