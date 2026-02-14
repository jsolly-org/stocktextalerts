import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { verifyCronSecret } from "../../../lib/schedule/cron-auth";
import { runScheduledNotifications } from "../../../lib/schedule/run";

/*
 * Vercel cron entrypoint. Validates `CRON_SECRET` and triggers scheduled deliveries.
 * GET  – used by Vercel cron.
 * POST – used by scripts/one-off-testing/run-scheduled-cron.sh (accepts `{ "force": true }`).
 */
const handler: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	const cronSecret = verifyCronSecret(request, logger);
	if (!cronSecret) {
		return new Response("Unauthorized", { status: 401 });
	}

	// Support manual sends: run-scheduled-cron.sh --force sends { force: true } so we
	// process all notification-enabled users immediately instead of only those with market_scheduled_asset_price_next_send_at <= now.
	let forceSend = false;
	const contentType = request.headers.get("content-type") ?? "";
	const contentLength = request.headers.get("content-length");
	if (contentType.includes("application/json")) {
		const rawBody = await request.text();
		if (rawBody.trim().length > 0) {
			let body: unknown;
			try {
				body = JSON.parse(rawBody);
			} catch (error) {
				logger.info("Invalid cron request body", {
					action: "cron_body_parse",
					reason: error instanceof Error ? error.message : String(error),
					contentType,
					contentLength,
					userAgent: request.headers.get("user-agent"),
				});
				return new Response("Bad Request", { status: 400 });
			}

			if (body && typeof body === "object") {
				const parsed = body as { force?: unknown };
				if (parsed.force === true) {
					forceSend = true;
				}
			}
		}
	}

	const supabase = createSupabaseAdminClient();

	try {
		const totals = await runScheduledNotifications({
			supabase,
			logger,
			forceSend,
			cronSecret,
		});

		return new Response(JSON.stringify({ success: true, ...totals }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		logger.error(
			"Cron job error",
			{ action: "scheduled_notifications_job" },
			error,
		);
		return new Response("Internal server error", { status: 500 });
	}
};

export const GET: APIRoute = handler;
export const POST: APIRoute = handler;
