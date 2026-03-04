import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { fetchAndStoreAssetEvents } from "../../../lib/asset-events/fetch";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { verifyCronSecret } from "../../../lib/schedule/cron-auth";

/**
 * Daily cron endpoint to pre-populate the `asset_events` table with
 * this week's and next week's earnings (Finnhub) and dividends/splits/IPOs (Massive).
 *
 * Runs daily at 00:00 UTC so newly-listed events and newly-tracked symbols
 * are picked up promptly. The DB unique index handles deduplication via upsert.
 */
const handler: APIRoute = async ({ url, request, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	if (!verifyCronSecret(request, logger)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const supabase = createSupabaseAdminClient();

	// Fetch two weeks: this week + next week.
	// This ensures users with late-week (Thu/Fri) deliveries whose 3-day
	// lookahead window extends into the following week still see those events.
	const thisMonday = DateTime.utc().startOf("week"); // Luxon weeks start Monday
	const nextMonday = thisMonday.plus({ weeks: 1 });

	const thisMondayStart = thisMonday.toISODate();
	const thisMondayEnd = thisMonday.plus({ days: 4 }).toISODate();
	const nextMondayStart = nextMonday.toISODate();
	const nextMondayEnd = nextMonday.plus({ days: 4 }).toISODate();

	const invalidDateRanges =
		!thisMonday.isValid ||
		!nextMonday.isValid ||
		!thisMondayStart ||
		!thisMondayEnd ||
		!nextMondayStart ||
		!nextMondayEnd;

	if (invalidDateRanges) {
		logger.error("Failed to compute week date range", {
			action: "daily_asset_events_cron",
			thisMonday: {
				isValid: thisMonday.isValid,
				invalidReason: thisMonday.invalidReason,
				weekStart: thisMondayStart,
				weekEnd: thisMondayEnd,
				dt: thisMonday.toString(),
			},
			nextMonday: {
				isValid: nextMonday.isValid,
				invalidReason: nextMonday.invalidReason,
				weekStart: nextMondayStart,
				weekEnd: nextMondayEnd,
				dt: nextMonday.toString(),
			},
		});
		return new Response("Internal server error", { status: 500 });
	}

	const weeks = [
		{
			weekStart: thisMondayStart,
			weekEnd: thisMondayEnd,
		},
		{
			weekStart: nextMondayStart,
			weekEnd: nextMondayEnd,
		},
	];

	try {
		const results: Array<{
			weekStart: string;
			weekEnd: string;
			upserted: number;
			failedProviders: string[];
		}> = [];
		for (const { weekStart, weekEnd } of weeks) {
			const result = await fetchAndStoreAssetEvents({
				supabase,
				weekStart,
				weekEnd,
				logger,
			});
			results.push({ weekStart, weekEnd, ...result });
		}

		const hasFailures = results.some((r) => r.failedProviders.length > 0);

		logger.info("Daily asset events fetch complete", {
			action: "daily_asset_events_cron",
			results,
			hasFailures,
		});

		return new Response(
			JSON.stringify({ success: !hasFailures, weeks: results }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		logger.error(
			"Daily asset events cron error",
			{ action: "daily_asset_events_cron" },
			error,
		);
		return new Response("Internal server error", { status: 500 });
	}
};

export const GET: APIRoute = handler;
