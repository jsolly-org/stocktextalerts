import type { Context, ScheduledEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../lib/db/supabase";
import { createLogger } from "../lib/logging";
import { getAndResetOptionalVendorSkipCount } from "../lib/providers/vendor-fault-tolerance";
import { runLambda } from "../lib/run-lambda";
import { runScheduledNotifications } from "../lib/schedule/run";

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "schedule",
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
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
					logger.error(
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
				logger.error("Failed to purge expired short URLs", { action: "purge_short_urls" }, error);
			}

			const optionalVendorSkips = getAndResetOptionalVendorSkipCount();
			logger.info("Schedule complete", {
				action: "schedule_complete",
				...totals,
				...(optionalVendorSkips > 0 ? { optionalVendorSkips } : {}),
			});
		} catch (error) {
			logger.error("Schedule failed", { action: "schedule_error" }, error);
			throw error;
		}
	});
}
