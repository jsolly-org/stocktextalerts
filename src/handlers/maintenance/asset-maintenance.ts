/**
 * Daily asset-data maintenance (EventBridge: midnight UTC). Ingests Finnhub
 * earnings/recommendation/insider data and Massive corporate actions, reconciles
 * the Massive tradable universe, and runs Massive delisting confirms (notifying
 * affected users). Enqueues vendor-backfill retries on partial ingest failures.
 * New-listing icon probes run inside universe reconcile (not a separate drip).
 *
 * Steps that spend vendor budget check the Lambda's remaining time first and skip
 * WITH AN ERROR LOG when they cannot fit, avoiding a partial step that ends in an
 * opaque Lambda timeout.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { DateTime } from "luxon";
import { fetchAndStoreFinnhubEnrichment } from "../../lib/asset-events/enrichment-store";
import { fetchAndStoreAssetEvents } from "../../lib/asset-events/fetch";
import type { AssetEventProvider } from "../../lib/asset-events/types";
import { PM_DISCOVERY_NIGHTLY_CAP } from "../../lib/assets/constants";
import { runDelistingSweep } from "../../lib/assets/delisting-sweep";
import { runUniverseReconcile } from "../../lib/assets/universe-reconcile";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger, type Logger } from "../../lib/logging";
import { runLambda } from "../../lib/logging/request-context";
import { createEmailSender } from "../../lib/messaging/email/utils";
import { runPredictionMarketDiscoveryDrip } from "../../lib/prediction-markets/pipeline";
import { refreshActivePredictionMarketSnapshots } from "../../lib/prediction-markets/refresh";
import { enqueueAssetEventsIngestRetry } from "../../lib/vendors/backfill/enqueue";
import {
	PM_DISCOVERY_MIN_REMAINING_MS,
	PM_REFRESH_MIN_REMAINING_MS,
	RECONCILE_MIN_REMAINING_MS,
	SWEEP_MIN_REMAINING_MS,
} from "./constants";

/**
 * True when the step fits the remaining Lambda time; on false, logs at ERROR (this
 * must page — a skipped sweep or reconcile is real missed work, and the next
 * invocation is a full day away).
 */
function stepFitsRemainingTime(
	context: Context,
	logger: Logger,
	step: string,
	requiredMs: number,
): boolean {
	const remainingMs = context.getRemainingTimeInMillis();
	if (remainingMs >= requiredMs) return true;
	logger.error(
		`Skipping ${step} — insufficient remaining Lambda time`,
		{ action: "daily_asset_maintenance_cron", step, remainingMs, requiredMs },
		new Error(`Step ${step} skipped: ${remainingMs}ms remaining < ${requiredMs}ms required`),
	);
	return false;
}

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
				"Finnhub enrichment ingest failed (continuing with prediction-market discovery)",
				{ action: "fetch_finnhub_enrichment" },
				error,
			);
		}

		// Refresh all active stored prediction-market event/outcome snapshots first
		// so digests stay DB-read-only against fresh odds. Soft-fails keep last good.
		if (stepFitsRemainingTime(context, logger, "pm_refresh", PM_REFRESH_MIN_REMAINING_MS)) {
			try {
				const refreshResult = await refreshActivePredictionMarketSnapshots({
					supabase,
					logger,
					getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(),
				});
				logger.info("Prediction-market snapshot refresh complete", {
					action: "daily_pm_refresh",
					...refreshResult,
				});
			} catch (error) {
				logger.error(
					"Prediction-market snapshot refresh failed",
					{ action: "daily_pm_refresh" },
					error,
				);
			}
		}

		// Tracked-only prediction-market discovery drip (pm_discovery_checked_at IS NULL).
		// After Finnhub enrichment, before delisting — demand-driven, scoped to user_assets.
		if (stepFitsRemainingTime(context, logger, "pm_discovery", PM_DISCOVERY_MIN_REMAINING_MS)) {
			try {
				const pmResult = await runPredictionMarketDiscoveryDrip({
					supabase,
					logger,
					limit: PM_DISCOVERY_NIGHTLY_CAP,
				});
				logger.info("Prediction-market discovery drip complete", {
					action: "daily_pm_discovery",
					...pmResult,
				});
			} catch (error) {
				logger.error(
					"Prediction-market discovery drip failed",
					{ action: "daily_pm_discovery" },
					error,
				);
			}
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

		// Nightly universe reconcile. Independent try/catch so a reconcile failure
		// never invalidates the calendar-events job or the delisting sweep. Ordered
		// before the sweep so it operates on a freshly reconciled universe.
		if (stepFitsRemainingTime(context, logger, "universe_reconcile", RECONCILE_MIN_REMAINING_MS)) {
			try {
				const reconcileResult = await runUniverseReconcile({ supabase, logger });
				logger.info("Universe reconcile complete", {
					action: "daily_universe_reconcile",
					...reconcileResult,
				});
			} catch (error) {
				logger.error("Universe reconcile failed", { action: "daily_universe_reconcile" }, error);
			}
		}

		// Independent try/catch so sweep failures never invalidate the calendar-
		// events job's success — the sweep runs again tomorrow.
		if (stepFitsRemainingTime(context, logger, "delisting_sweep", SWEEP_MIN_REMAINING_MS)) {
			try {
				const sendEmail = createEmailSender();
				const sweepResult = await runDelistingSweep({
					supabase,
					logger,
					sendEmail,
				});
				logger.info("Delisting sweep complete", {
					action: "daily_delisting_sweep",
					...sweepResult,
				});
			} catch (error) {
				logger.error("Delisting sweep failed", { action: "daily_delisting_sweep" }, error);
			}
		}
	});
}
