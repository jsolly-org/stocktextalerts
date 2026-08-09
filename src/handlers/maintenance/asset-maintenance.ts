/**
 * Daily asset-data maintenance (EventBridge: midnight UTC). Ingests Finnhub
 * earnings/recommendation/insider data and Massive corporate actions, reconciles
 * the Massive tradable universe, and runs Massive delisting confirms (notifying
 * affected users). Enqueues vendor-backfill retries on partial ingest failures.
 * New-listing icon probes run inside universe reconcile (not a separate drip).
 *
 * Integrity work (delisting sweep + universe reconcile) runs before unbounded
 * prediction-market steps so Polymarket rate limits / discovery page walks cannot
 * starve user-facing delist emails or the nightly universe sync.
 *
 * Steps that spend vendor budget check the Lambda's remaining time first and skip
 * WITH AN ERROR LOG when they cannot fit, avoiding a partial step that ends in an
 * opaque Lambda timeout.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { DateTime } from "luxon";
import { fetchAndStoreFinnhubEnrichment } from "../../lib/asset-events/enrichment-store";
import { fetchAndStoreAssetEvents } from "../../lib/asset-events/fetch";
import { fetchAndStoreSecFilings } from "../../lib/asset-events/sec-filings";
import { fetchAndStoreShortInterest } from "../../lib/asset-events/short-interest";
import type { AssetEventProvider } from "../../lib/asset-events/types";
import { runDelistingSweep } from "../../lib/assets/delisting-sweep";
import { runUniverseReconcile } from "../../lib/assets/universe-reconcile";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger, type Logger } from "../../lib/logging";
import { RELEASE_ID } from "../../lib/logging/release-id";
import { runLambda } from "../../lib/logging/request-context";
import { createEmailSender } from "../../lib/messaging/email/utils";
import { runNextSessionDirectionProbe } from "../../lib/prediction-markets/direction-probe";
import { runPredictionMarketDiscoveryDrip } from "../../lib/prediction-markets/pipeline";
import { refreshActivePredictionMarketSnapshots } from "../../lib/prediction-markets/refresh";
import { enqueueAssetEventsIngestRetry } from "../../lib/vendors/backfill/enqueue";
import {
	ENRICHMENT_MIN_REMAINING_MS,
	PM_DIRECTION_PROBE_MIN_REMAINING_MS,
	PM_DISCOVERY_MIN_REMAINING_MS,
	PM_REFRESH_MIN_REMAINING_MS,
	RECONCILE_MIN_REMAINING_MS,
	SEC_FILINGS_MIN_REMAINING_MS,
	SHORT_INTEREST_MIN_REMAINING_MS,
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
			releaseId: RELEASE_ID,
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

		// Delisting + reconcile before Finnhub O(n) enrichment and unbounded PM
		// work. Tracked-symbol growth (and Polymarket discovery page walks) must
		// not starve user-facing delist emails or the universe sync — same class
		// of bug as the 2026-08 icon-fanout starvation (#668), with PM as the
		// consumer instead of Massive icons.
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

		let enrichmentResult: Awaited<ReturnType<typeof fetchAndStoreFinnhubEnrichment>> = {
			analystUpserted: 0,
			insiderUpserted: 0,
			enrichmentFailures: [],
		};
		if (stepFitsRemainingTime(context, logger, "finnhub_enrichment", ENRICHMENT_MIN_REMAINING_MS)) {
			try {
				enrichmentResult = await fetchAndStoreFinnhubEnrichment({ supabase, logger });
			} catch (error) {
				logger.error(
					"Finnhub enrichment ingest failed (continuing with SEC filings ingest)",
					{ action: "fetch_finnhub_enrichment" },
					error,
				);
			}
		}

		if (stepFitsRemainingTime(context, logger, "sec_filings", SEC_FILINGS_MIN_REMAINING_MS)) {
			try {
				await fetchAndStoreSecFilings({ supabase, logger });
			} catch (error) {
				logger.error(
					"SEC filings ingest failed (continuing with short-interest ingest)",
					{ action: "fetch_sec_filings" },
					error,
				);
			}
		}

		if (stepFitsRemainingTime(context, logger, "short_interest", SHORT_INTEREST_MIN_REMAINING_MS)) {
			try {
				await fetchAndStoreShortInterest({ supabase, logger });
			} catch (error) {
				logger.error(
					"Short interest ingest failed (continuing with prediction-market refresh)",
					{ action: "fetch_short_interest" },
					error,
				);
			}
		}

		// Best-effort PM work last: soft-fails + remaining-time abort are fine;
		// digest odds can lag a day without missing delist/reconcile integrity.
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

		// Rotating Polymarket daily up/down markets are created ~noon UTC the day
		// before the session. One-shot discovery never sees them — probe the
		// deterministic slug for every tracked symbol and upsert additively.
		if (
			stepFitsRemainingTime(
				context,
				logger,
				"pm_direction_probe",
				PM_DIRECTION_PROBE_MIN_REMAINING_MS,
			)
		) {
			try {
				const probeResult = await runNextSessionDirectionProbe({
					supabase,
					logger,
					getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(),
				});
				logger.info("Prediction-market next-session direction probe complete", {
					action: "daily_pm_direction_probe",
					...probeResult,
				});
			} catch (error) {
				logger.error(
					"Prediction-market next-session direction probe failed",
					{ action: "daily_pm_direction_probe" },
					error,
				);
			}
		}

		// Unchecked tracked symbols (pm_discovery_checked_at IS NULL). Remaining-time
		// abort + checked_at stamps are the backstops; Polymarket search pages are
		// capped so popular-ticker noise cannot monopolize the invoke.
		if (stepFitsRemainingTime(context, logger, "pm_discovery", PM_DISCOVERY_MIN_REMAINING_MS)) {
			try {
				const pmResult = await runPredictionMarketDiscoveryDrip({
					supabase,
					logger,
					getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(),
				});
				logger.info("Prediction-market discovery complete", {
					action: "daily_pm_discovery",
					...pmResult,
				});
			} catch (error) {
				logger.error("Prediction-market discovery failed", { action: "daily_pm_discovery" }, error);
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
	});
}
