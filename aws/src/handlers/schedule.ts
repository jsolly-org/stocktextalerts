import type { Context, ScheduledEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import { createLogger } from "../../../src/lib/logging";
import { runScheduledNotifications } from "../../../src/lib/schedule/run";

export async function handler(_event: ScheduledEvent, context: Context): Promise<void> {
	const logger = createLogger({
		baseContext: { source: "lambda", function: "schedule" },
		lambdaContext: context,
	});
	const supabase = createSupabaseAdminClient();

	try {
		const totals = await runScheduledNotifications({ supabase, logger });

		// Purge expired short URLs (non-blocking)
		try {
			const { data: purgedUrls, error: purgeError } = await supabase.rpc(
				"purge_expired_short_urls",
			);
			if (purgeError) {
				logger.warn(
					"Failed to purge expired short URLs",
					{ action: "purge_short_urls" },
					purgeError,
				);
			} else if (purgedUrls && purgedUrls > 0) {
				logger.info("Purged expired short URLs", {
					action: "purge_short_urls",
					deletedCount: purgedUrls,
				});
			}
		} catch (error) {
			logger.warn(
				"Failed to purge expired short URLs",
				{ action: "purge_short_urls" },
				error,
			);
		}

		logger.info("Schedule complete", {
			action: "schedule_complete",
			...totals,
		});
	} catch (error) {
		logger.error("Schedule failed", { action: "schedule_error" }, error);
		throw error;
	}
}
