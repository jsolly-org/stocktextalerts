import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createEmailSender } from "../../../lib/messaging/email/utils";
import type { UserRecord } from "../../../lib/messaging/types";
import { verifyCronSecret } from "../../../lib/schedule/cron-auth";
import { processDailyUser } from "../../../lib/schedule/run-user-daily";
import { createSmsSenderProvider } from "../../../lib/schedule/run-user-sms-sender";

/**
 * Per-user daily endpoint — called by the fan-out dispatcher.
 * Each invocation gets its own Vercel function timeout budget.
 */
export const POST: APIRoute = async ({ request, locals }) => {
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

	let body: { userId?: string; currentTimeIso?: string; marketOpen?: boolean };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	const { userId, currentTimeIso, marketOpen } = body;
	if (!userId || !currentTimeIso || typeof marketOpen !== "boolean") {
		return new Response("Bad Request: missing required fields", {
			status: 400,
		});
	}

	const currentTime = DateTime.fromISO(currentTimeIso, { zone: "utc" });
	if (!currentTime.isValid) {
		return new Response("Bad Request: invalid currentTimeIso", {
			status: 400,
		});
	}

	const supabase = createSupabaseAdminClient();

	// Fetch the single user record with the same columns as fetchDailyUsers
	const { data: user, error: fetchError } = await supabase
		.from("users")
		.select(
			`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			timezone,
			daily_only_notify_when_market_open,
			daily_delivery_time,
			daily_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			daily_include_news,
			daily_include_rumors,
			daily_include_analyst,
			daily_include_insider,
			last_grok_rumors_at,
			grok_window_start,
			grok_sends_in_window
		`,
		)
		.eq("id", userId)
		.maybeSingle();

	if (fetchError) {
		logger.error(
			"Failed to fetch user for daily dispatch",
			{ userId },
			fetchError,
		);
		return new Response("Internal server error", { status: 500 });
	}

	if (!user) {
		logger.warn("User not found for daily dispatch", { userId });
		return new Response(
			JSON.stringify({
				skipped: 1,
				logFailures: 0,
				emailsSent: 0,
				emailsFailed: 0,
				smsSent: 0,
				smsFailed: 0,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();

	const stats = await processDailyUser({
		user: user as unknown as UserRecord,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		marketOpen,
	});

	return new Response(JSON.stringify(stats), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
