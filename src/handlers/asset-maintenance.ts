import type { Context, ScheduledEvent } from "aws-lambda";
import { DateTime } from "luxon";
import { fetchAndStoreFinnhubEnrichment } from "../lib/asset-events/enrichment-store";
import type { AssetEventProvider } from "../lib/asset-events/fetch";
import { fetchAndStoreAssetEvents } from "../lib/asset-events/fetch";
import { runDelistingSweep } from "../lib/assets/delisting-sweep";
import { runUniverseReconcile } from "../lib/assets/universe-reconcile";
import { createSupabaseAdminClient } from "../lib/db/supabase";
import { createLogger } from "../lib/logging";
import { runLambda } from "../lib/logging/request-context";
import { createEmailSender } from "../lib/messaging/email/utils";
import { createSmsSenderFactory } from "../lib/messaging/sms/sender-factory";
import { enqueueAssetEventsIngestRetry } from "../lib/vendors/backfill/enqueue";

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "asset-maintenance",
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
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
			logger.error(
				"Failed to compute week date range",
				{
					action: "daily_asset_maintenance_cron",
					thisMonday: {
						isValid: thisMonday.isValid,
						invalidReason: thisMonday.invalidReason,
					},
					nextMonday: {
						isValid: nextMonday.isValid,
						invalidReason: nextMonday.invalidReason,
					},
				},
				new Error(
					`Invalid Luxon week range: ${thisMonday.invalidReason ?? nextMonday.invalidReason ?? "unknown"}`,
				),
			);
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

		let enrichmentResult: Awaited<ReturnType<typeof fetchAndStoreFinnhubEnrichment>> = {
			analystUpserted: 0,
			insiderUpserted: 0,
			enrichmentFailures: [],
		};
		try {
			enrichmentResult = await fetchAndStoreFinnhubEnrichment({ supabase, logger });
		} catch (error) {
			logger.error(
				"Finnhub enrichment ingest failed (continuing with delisting sweep)",
				{ action: "fetch_finnhub_enrichment" },
				error,
			);
		}

		const hasFailures = results.some((r) => r.failedProviders.length > 0);

		logger.info("Daily asset events fetch complete", {
			action: "daily_asset_maintenance_cron",
			results,
			hasFailures,
			finnhubEnrichment: enrichmentResult,
		});

		if (hasFailures) {
			const failedProviders = results.flatMap((r) => r.failedProviders);
			logger.error(
				"Some asset event providers failed",
				{ action: "daily_asset_maintenance_cron", failedProviders },
				new Error(`Failed providers: ${failedProviders.join(", ")}`),
			);

			for (const result of results) {
				if (result.failedProviders.length === 0) continue;
				const enqueued = await enqueueAssetEventsIngestRetry({
					weekStart: result.weekStart,
					weekEnd: result.weekEnd,
					providers: result.failedProviders as AssetEventProvider[],
					reason: "daily_asset_events_partial_failure",
				});
				if (!enqueued) {
					logger.error(
						"Failed to enqueue asset-events vendor backfill",
						{
							action: "daily_asset_maintenance_cron",
							weekStart: result.weekStart,
							weekEnd: result.weekEnd,
							providers: result.failedProviders,
						},
						new Error("SQS enqueue failed"),
					);
				}
			}
		}

		// Independent try/catch so a reconcile failure never invalidates the
		// calendar-events job or the delisting sweep — reconcile runs again
		// tomorrow. Ordered BEFORE the sweep so the sweep operates on a freshly
		// reconciled universe; the sweep remains the authoritative path for
		// tracked-symbol delisting.
		try {
			const reconcileResult = await runUniverseReconcile({ supabase, logger });
			logger.info("Universe reconcile complete", {
				action: "daily_universe_reconcile",
				...reconcileResult,
			});
		} catch (error) {
			logger.error("Universe reconcile failed", { action: "daily_universe_reconcile" }, error);
		}

		// Independent try/catch so sweep failures never invalidate the calendar-
		// events job's success — the sweep runs again tomorrow.
		try {
			const sendEmail = createEmailSender();
			const getSmsSender = createSmsSenderFactory();
			const sweepResult = await runDelistingSweep({
				supabase,
				logger,
				sendEmail,
				getSmsSender,
			});
			logger.info("Delisting sweep complete", {
				action: "daily_delisting_sweep",
				...sweepResult,
			});
		} catch (error) {
			logger.error("Delisting sweep failed", { action: "daily_delisting_sweep" }, error);
		}
	});
}
