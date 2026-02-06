import { createHash, timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { runScheduledNotifications } from "../../../lib/schedule/run";

/**
 * Vercel cron entrypoint. Validates `CRON_SECRET` and triggers scheduled deliveries.
 * Accepts `{ "force": true }` to run a manual send regardless of `next_send_at`.
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const authHeader = request.headers.get("authorization");
	const envCronSecret = import.meta.env.CRON_SECRET;

	if (!authHeader) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "missing_authorization_header",
		});
		return new Response("Unauthorized", { status: 401 });
	}

	if (!authHeader.startsWith("Bearer ")) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "malformed_authorization_header",
		});
		return new Response("Unauthorized", { status: 401 });
	}

	const cronSecret = authHeader.split("Bearer ")[1];
	let authorized = false;

	try {
		const suppliedSecret = createHash("sha256").update(cronSecret).digest();
		const expectedSecret = createHash("sha256").update(envCronSecret).digest();
		authorized = timingSafeEqual(suppliedSecret, expectedSecret);
	} catch (error) {
		logger.error(
			"Failed to compare cron secrets securely",
			{ action: "compare_cron_secret" },
			error,
		);
		return new Response("Internal server error", { status: 500 });
	}

	if (!authorized) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "cron_secret_mismatch",
		});
		return new Response("Unauthorized", { status: 401 });
	}

	// Support manual sends: run-scheduled-cron.sh --force sends { force: true } so we
	// process all notification-enabled users immediately instead of only those with next_send_at <= now.
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
