import type { Context, ScheduledEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../lib/db/supabase";
import { createLogger } from "../lib/logging";
import { runLambda } from "../lib/logging/request-context";
import { getAndResetOptionalVendorSkipCount } from "../lib/resilience/optional-vendors";
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

			// Purge expired email-dispatch idempotency keys (non-blocking)
			try {
				const { data: purgedKeys, error: purgeKeysError } = await supabase.rpc(
					"purge_expired_email_dispatch_keys",
				);
				if (purgeKeysError) {
					logger.error(
						"Failed to purge expired email-dispatch keys",
						{ action: "purge_email_dispatch_keys" },
						purgeKeysError,
					);
				} else if (purgedKeys && purgedKeys > 0) {
					logger.info("Purged expired email-dispatch keys", {
						action: "purge_email_dispatch_keys",
						deletedCount: purgedKeys,
					});
				}
			} catch (error) {
				logger.error(
					"Failed to purge expired email-dispatch keys",
					{ action: "purge_email_dispatch_keys" },
					error,
				);
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
