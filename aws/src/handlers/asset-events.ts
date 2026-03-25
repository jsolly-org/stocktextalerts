import type { ScheduledEvent } from "aws-lambda";
import { DateTime } from "luxon";
import { fetchAndStoreAssetEvents } from "../../../src/lib/asset-events/fetch";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import { createLogger } from "../../../src/lib/logging";

export async function handler(_event: ScheduledEvent): Promise<void> {
	const logger = createLogger({
		source: "lambda",
		function: "asset-events",
	});
	const supabase = createSupabaseAdminClient();

	// Fetch two weeks: this week + next week.
	// This ensures users with late-week (Thu/Fri) deliveries whose 3-day
	// lookahead window extends into the following week still see those events.
	const thisMonday = DateTime.utc().startOf("week");
	const nextMonday = thisMonday.plus({ weeks: 1 });

	const thisMondayStart = thisMonday.toISODate();
	const thisMondayEnd = thisMonday.plus({ days: 4 }).toISODate();
	const nextMondayStart = nextMonday.toISODate();
	const nextMondayEnd = nextMonday.plus({ days: 4 }).toISODate();

	if (
		!thisMonday.isValid ||
		!nextMonday.isValid ||
		!thisMondayStart ||
		!thisMondayEnd ||
		!nextMondayStart ||
		!nextMondayEnd
	) {
		logger.error("Failed to compute week date range", {
			action: "daily_asset_events_cron",
			thisMonday: {
				isValid: thisMonday.isValid,
				invalidReason: thisMonday.invalidReason,
			},
			nextMonday: {
				isValid: nextMonday.isValid,
				invalidReason: nextMonday.invalidReason,
			},
		});
		throw new Error("Invalid date range for asset events");
	}

	const weeks = [
		{ weekStart: thisMondayStart, weekEnd: thisMondayEnd },
		{ weekStart: nextMondayStart, weekEnd: nextMondayEnd },
	];

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

	if (hasFailures) {
		logger.warn("Some asset event providers failed", {
			action: "daily_asset_events_cron",
			failedProviders: results.flatMap((r) => r.failedProviders),
		});
	}
}
