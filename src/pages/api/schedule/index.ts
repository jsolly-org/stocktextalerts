import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { runScheduledNotifications } from "../../../lib/schedule/run";

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

	if (cronSecret.length !== envCronSecret.length) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "cron_secret_length_mismatch",
		});
		return new Response("Unauthorized", { status: 401 });
	}

	if (cronSecret.length === envCronSecret.length) {
		try {
			authorized = timingSafeEqual(
				Buffer.from(cronSecret),
				Buffer.from(envCronSecret),
			);
		} catch (error) {
			logger.error(
				"Failed to compare cron secrets securely",
				{ action: "compare_cron_secret" },
				error,
			);
			return new Response("Internal server error", { status: 500 });
		}
	}

	if (!authorized) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "cron_secret_mismatch",
		});
		return new Response("Unauthorized", { status: 401 });
	}

	// Support manual sends: run-scheduled-cron.sh --force sends { force: true } so we
	// process all digest-enabled users immediately instead of only those with next_send_at <= now.
	let forceSend = false;
	try {
		const contentType = request.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			const body = await request.json();
			if (body && typeof body === "object" && body.force === true) {
				forceSend = true;
			}
		}
	} catch {
		// Ignore invalid or empty body; treat as normal run.
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
