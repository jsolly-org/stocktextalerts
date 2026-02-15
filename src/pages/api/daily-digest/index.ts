import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { processDailyDigestUser } from "../../../lib/daily-digest/process";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createEmailSender } from "../../../lib/messaging/email/utils";
import type { UserRecord } from "../../../lib/messaging/types";
import { verifyCronSecret } from "../../../lib/schedule/cron-auth";
import { createSmsSenderProvider } from "../../../lib/schedule/sms-sender";

type DailyDigestUserRow = Pick<
	UserRecord,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "daily_digest_time"
	| "daily_digest_next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "show_sparklines"
	| "daily_digest_include_news_email"
	| "daily_digest_include_rumors_email"
	| "asset_events_include_calendar_email"
	| "asset_events_include_calendar_sms"
	| "asset_events_include_ipo_email"
	| "asset_events_include_ipo_sms"
	| "asset_events_include_analyst_email"
	| "asset_events_include_analyst_sms"
	| "asset_events_include_insider_email"
	| "asset_events_include_insider_sms"
	| "asset_events_next_send_at"
	| "asset_events_last_analyst_sent_month"
	| "last_grok_rumors_at"
	| "grok_window_start"
	| "grok_sends_in_window"
>;

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

	let body: { userId?: string; currentTimeIso?: string; precompute?: boolean };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	const { userId, currentTimeIso, precompute } = body;
	const parsedCurrentTime =
		typeof currentTimeIso === "string"
			? DateTime.fromISO(currentTimeIso, { zone: "utc" })
			: null;
	if (
		typeof userId !== "string" ||
		userId.trim() === "" ||
		typeof currentTimeIso !== "string" ||
		currentTimeIso.trim() === "" ||
		parsedCurrentTime === null ||
		!parsedCurrentTime.isValid
	) {
		return new Response("Bad Request: missing required fields", {
			status: 400,
		});
	}

	const currentTime = parsedCurrentTime;

	const supabase = createSupabaseAdminClient();

	// Fetch the single user record with the same columns as fetchDailyDigestUsers
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
			daily_digest_time,
			daily_digest_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			show_sparklines,
			daily_digest_include_news_email,
			daily_digest_include_rumors_email,
			asset_events_include_calendar_email,
			asset_events_include_calendar_sms,
			asset_events_include_ipo_email,
			asset_events_include_ipo_sms,
			asset_events_include_analyst_email,
			asset_events_include_analyst_sms,
			asset_events_include_insider_email,
			asset_events_include_insider_sms,
			asset_events_next_send_at,
			asset_events_last_analyst_sent_month,
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

	const dailyDigestUser: UserRecord = {
		...(user as DailyDigestUserRow),
		// Not required for daily digest processing, but part of UserRecord.
		// Provide safe defaults rather than bypassing type checking via `unknown`.
		market_scheduled_asset_price_next_send_at: null,
		market_scheduled_asset_price_enabled: false,
		market_scheduled_asset_price_include_email: false,
		market_scheduled_asset_price_include_sms: false,
		market_scheduled_asset_price_times: null,
	};

	const stats = await processDailyDigestUser({
		user: dailyDigestUser,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		stageOnly: precompute === true,
	});

	return new Response(JSON.stringify(stats), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
