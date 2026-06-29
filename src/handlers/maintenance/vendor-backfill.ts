/**
 * SQS consumer for deferred vendor API work. Retries failed Massive/Finnhub
 * operations enqueued by other Lambdas or the web tier — asset-events ingest,
 * daily-close cache backfill, price-history store, and new-symbol warmup.
 * Reports partial batch failures for SQS redrive.
 */
import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { runLambda } from "../../lib/logging/request-context";
import { handleVendorBackfillBatch } from "../../lib/vendors/backfill/batch";

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "vendor-backfill",
		});
		logger.info("Vendor backfill batch invoke", {
			action: "vendor_backfill_invoke",
			recordCount: event.Records.length,
		});

		const supabase = createSupabaseAdminClient();
		const batchItemFailures = await handleVendorBackfillBatch({
			records: event.Records,
			supabase,
			logger,
		});

		return { batchItemFailures };
	});
}
