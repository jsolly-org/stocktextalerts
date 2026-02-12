import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { fetchAndStoreAssetEvents } from "../../../lib/asset-events/fetch";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { verifyCronSecret } from "../../../lib/schedule/cron-auth";

/**
 * Weekly cron endpoint to pre-populate the `asset_events` table with
 * next week's earnings, dividends, and splits from Polygon.io.
 *
 * Runs every Saturday at 00:00 UTC so events are ready before Monday
 * deliveries, even for users in far-ahead timezones (e.g. UTC+14).
 */
const handler: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	if (!verifyCronSecret(request, logger)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const supabase = createSupabaseAdminClient();

	// Fetch two weeks: next week + the week after.
	// This ensures users with late-week (Thu/Fri) deliveries whose 3-day
	// lookahead window extends into the following week still see those events.
	const nextMonday = DateTime.utc().plus({ weeks: 1 }).startOf("week"); // Luxon weeks start Monday
	const weekAfterMonday = nextMonday.plus({ weeks: 1 });

	const weeks = [
		{
			weekStart: nextMonday.toISODate() ?? "",
			weekEnd: nextMonday.plus({ days: 4 }).toISODate() ?? "",
		},
		{
			weekStart: weekAfterMonday.toISODate() ?? "",
			weekEnd: weekAfterMonday.plus({ days: 4 }).toISODate() ?? "",
		},
	];

	try {
		const results = [];
		for (const { weekStart, weekEnd } of weeks) {
			const result = await fetchAndStoreAssetEvents({
				supabase,
				weekStart,
				weekEnd,
				logger,
			});
			results.push({ weekStart, weekEnd, ...result });
		}

		logger.info("Weekly asset events fetch complete", {
			action: "weekly_asset_events_cron",
			results,
		});

		return new Response(JSON.stringify({ success: true, weeks: results }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		logger.error(
			"Weekly asset events cron error",
			{ action: "weekly_asset_events_cron" },
			error,
		);
		return new Response("Internal server error", { status: 500 });
	}
};

export const GET: APIRoute = handler;
