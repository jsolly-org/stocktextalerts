/**
 * Orchestration tests for the daily asset-maintenance Lambda: the Sunday-only
 * universe-reconcile cadence and the per-step remaining-time budget guards.
 *
 * Every step implementation (ingest, enrichment, reconcile, sweep, icon backfill)
 * is mocked — the handler is thin orchestration, and what these tests pin is
 * WHICH steps run under which clock/budget conditions, plus the pageable error
 * logs when a step is skipped.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { errorMessages, expectConsoleError, loggedMessages } from "../../setup";

vi.mock("../../../src/lib/asset-events/enrichment-store", () => ({
	fetchAndStoreFinnhubEnrichment: vi.fn(),
}));
vi.mock("../../../src/lib/asset-events/fetch", () => ({
	fetchAndStoreAssetEvents: vi.fn(),
}));
vi.mock("../../../src/lib/assets/delisting-sweep", () => ({
	runDelistingSweep: vi.fn(),
}));
vi.mock("../../../src/lib/assets/icon-backfill", () => ({
	runIconBackfill: vi.fn(),
}));
vi.mock("../../../src/lib/assets/universe-reconcile", () => ({
	runUniverseReconcile: vi.fn(),
}));
vi.mock("../../../src/lib/db/supabase", () => ({
	createSupabaseAdminClient: vi.fn(),
}));
vi.mock("../../../src/lib/messaging/email/utils", () => ({
	createEmailSender: vi.fn(),
}));
vi.mock("../../../src/lib/vendors/backfill/enqueue", () => ({
	enqueueAssetEventsIngestRetry: vi.fn(),
}));
vi.mock("../../../src/lib/prediction-markets/pipeline", () => ({
	runPredictionMarketDiscoveryDrip: vi.fn(),
}));

import { handler } from "../../../src/handlers/maintenance/asset-maintenance";
import {
	ICON_BACKFILL_MIN_REMAINING_MS,
	PM_DISCOVERY_MIN_REMAINING_MS,
	RECONCILE_MIN_REMAINING_MS,
	SWEEP_MIN_REMAINING_MS,
} from "../../../src/handlers/maintenance/constants";
import { fetchAndStoreFinnhubEnrichment } from "../../../src/lib/asset-events/enrichment-store";
import { fetchAndStoreAssetEvents } from "../../../src/lib/asset-events/fetch";
import { runDelistingSweep } from "../../../src/lib/assets/delisting-sweep";
import { runIconBackfill } from "../../../src/lib/assets/icon-backfill";
import { runUniverseReconcile } from "../../../src/lib/assets/universe-reconcile";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import { createEmailSender } from "../../../src/lib/messaging/email/utils";
import { runPredictionMarketDiscoveryDrip } from "../../../src/lib/prediction-markets/pipeline";
import { enqueueAssetEventsIngestRetry } from "../../../src/lib/vendors/backfill/enqueue";

/** Midnight-UTC schedule ticks on known weekdays (2026-07-05 is a Sunday). */
const SUNDAY_UTC = new Date("2026-07-05T00:00:30Z");
const WEDNESDAY_UTC = new Date("2026-07-08T00:00:30Z");

/** Comfortably above every per-step budget (the Lambda's full 900s timeout). */
const AMPLE_REMAINING_MS = 900_000;
/** Clearly below every per-step budget. */
const STARVED_REMAINING_MS =
	Math.min(
		RECONCILE_MIN_REMAINING_MS,
		SWEEP_MIN_REMAINING_MS,
		ICON_BACKFILL_MIN_REMAINING_MS,
		PM_DISCOVERY_MIN_REMAINING_MS,
	) - 60_000;

const event = { id: "evt-asset-maint-1", time: "2026-07-05T00:00:00Z" } as ScheduledEvent;

/** A fake Lambda Context whose remaining-time clock the test controls. */
function makeContext(remainingMs: number): Context {
	return {
		awsRequestId: "test-request-id",
		getRemainingTimeInMillis: () => remainingMs,
	} as unknown as Context;
}

function stubHealthySteps(): void {
	vi.mocked(createSupabaseAdminClient).mockReturnValue(
		{} as ReturnType<typeof createSupabaseAdminClient>,
	);
	vi.mocked(createEmailSender).mockReturnValue(async () => ({ success: true }));
	vi.mocked(fetchAndStoreAssetEvents).mockResolvedValue({ upserted: 34, failedProviders: [] });
	vi.mocked(fetchAndStoreFinnhubEnrichment).mockResolvedValue({
		analystUpserted: 12,
		insiderUpserted: 7,
		enrichmentFailures: [],
	});
	vi.mocked(runUniverseReconcile).mockResolvedValue({
		activeTickersFetched: 11234,
		allActiveSymbols: 26890,
		newListingsInserted: 18,
		insertChunksFailed: 0,
		delistedCleared: 2,
		untrackedDelistedFlagged: 5,
		delistFlagSkippedShrunkActive: false,
		warmupEnqueued: 18,
		warmupEnqueueFailed: 0,
		warmupSkippedCap: 0,
		providerFetchFailed: false,
	});
	vi.mocked(runDelistingSweep).mockResolvedValue({
		symbolsChecked: 15,
		newlyDetectedDelistings: 1,
		reprocessedDelistings: 0,
		usersNotified: 1,
		emailsDelivered: 1,
		emailsSkippedOptOut: 0,
		emailsFailed: 0,
		userAssetRowsDeleted: 1,
		providerErrors: 0,
	});
	vi.mocked(runIconBackfill).mockResolvedValue({
		candidatesRemaining: 1843,
		checked: 25,
		iconsFound: 18,
		fetchFailed: 2,
		writeFailed: 0,
	});
	vi.mocked(runPredictionMarketDiscoveryDrip).mockResolvedValue({
		processed: 3,
		matched: 2,
		failed: 0,
	});
	vi.mocked(enqueueAssetEventsIngestRetry).mockResolvedValue(true);
}

describe("asset-maintenance Lambda orchestration", () => {
	let infoSpy: MockInstance<typeof console.info>;

	beforeEach(() => {
		vi.clearAllMocks();
		stubHealthySteps();
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		// Fake only the Date clock: the handler awaits mocked promises (no timers),
		// and luxon's DateTime.utc() reads Date.now().
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		infoSpy.mockRestore();
	});

	it("On a Sunday tick the weekly universe reconcile runs (before the sweep)", async () => {
		vi.setSystemTime(SUNDAY_UTC);

		await handler(event, makeContext(AMPLE_REMAINING_MS));

		expect(runUniverseReconcile).toHaveBeenCalledTimes(1);
		expect(loggedMessages(infoSpy)).toContainEqual("Universe reconcile complete");
		// Reconcile day never displaces the nightly steps.
		expect(runPredictionMarketDiscoveryDrip).toHaveBeenCalledTimes(1);
		expect(runDelistingSweep).toHaveBeenCalledTimes(1);
		expect(runIconBackfill).toHaveBeenCalledTimes(1);
	});

	it("On a Wednesday tick the reconcile is skipped, but the nightly drip, sweep and icon backfill still run", async () => {
		vi.setSystemTime(WEDNESDAY_UTC);

		await handler(event, makeContext(AMPLE_REMAINING_MS));

		expect(runUniverseReconcile).not.toHaveBeenCalled();
		expect(loggedMessages(infoSpy)).toContainEqual("Universe reconcile skipped — runs weekly");
		expect(runPredictionMarketDiscoveryDrip).toHaveBeenCalledTimes(1);
		expect(runDelistingSweep).toHaveBeenCalledTimes(1);
		expect(runIconBackfill).toHaveBeenCalledTimes(1);
	});

	it("A starved invocation (remaining time below every step budget) skips reconcile, pm discovery, sweep, and icon backfill with pageable error logs", async () => {
		vi.setSystemTime(SUNDAY_UTC);
		expectConsoleError(/Skipping universe_reconcile/);
		expectConsoleError(/Skipping pm_discovery/);
		expectConsoleError(/Skipping delisting_sweep/);
		expectConsoleError(/Skipping icon_backfill/);

		await handler(event, makeContext(STARVED_REMAINING_MS));

		// The unguarded calendar ingest still ran; every budget-guarded step did not.
		expect(fetchAndStoreAssetEvents).toHaveBeenCalledTimes(2);
		expect(runUniverseReconcile).not.toHaveBeenCalled();
		expect(runPredictionMarketDiscoveryDrip).not.toHaveBeenCalled();
		expect(runDelistingSweep).not.toHaveBeenCalled();
		expect(runIconBackfill).not.toHaveBeenCalled();
		// The skip is not silent: each guarded step left an ERROR log (ErrorLogAlarm pages).
		expect(errorMessages()).toContainEqual(expect.stringContaining("Skipping universe_reconcile"));
		expect(errorMessages()).toContainEqual(expect.stringContaining("Skipping pm_discovery"));
		expect(errorMessages()).toContainEqual(expect.stringContaining("Skipping delisting_sweep"));
		expect(errorMessages()).toContainEqual(expect.stringContaining("Skipping icon_backfill"));
	});

	it("With ample remaining time every step runs, summaries are logged, and nothing errors", async () => {
		vi.setSystemTime(SUNDAY_UTC);

		await handler(event, makeContext(AMPLE_REMAINING_MS));

		// Two calendar windows: this week + next week (Mondays around the Sunday tick).
		expect(fetchAndStoreAssetEvents).toHaveBeenCalledTimes(2);
		expect(fetchAndStoreAssetEvents).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ weekStart: "2026-06-29", weekEnd: "2026-07-03" }),
		);
		expect(fetchAndStoreAssetEvents).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ weekStart: "2026-07-06", weekEnd: "2026-07-10" }),
		);
		expect(fetchAndStoreFinnhubEnrichment).toHaveBeenCalledTimes(1);
		expect(runPredictionMarketDiscoveryDrip).toHaveBeenCalledTimes(1);
		expect(runUniverseReconcile).toHaveBeenCalledTimes(1);
		expect(runDelistingSweep).toHaveBeenCalledTimes(1);
		expect(runIconBackfill).toHaveBeenCalledTimes(1);
		// Nothing failed, so no vendor-backfill retry was enqueued.
		expect(enqueueAssetEventsIngestRetry).not.toHaveBeenCalled();

		const summaries = loggedMessages(infoSpy);
		expect(summaries).toContainEqual("Daily asset events fetch complete");
		expect(summaries).toContainEqual("Prediction-market discovery drip complete");
		expect(summaries).toContainEqual("Universe reconcile complete");
		expect(summaries).toContainEqual("Delisting sweep complete");
		expect(summaries).toContainEqual("Icon backfill complete");
		// No expectConsoleError() registered: tests/setup.ts fails this test on ANY
		// console.error, so "nothing errors" is enforced automatically.
	});
});
