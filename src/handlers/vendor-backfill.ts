import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../lib/db/supabase";
import { createLogger } from "../lib/logging";
import { runWithRequestContext } from "../lib/logging/request-context";
import { handleVendorBackfillBatch } from "../lib/vendor-backfill/queue";

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
	return runWithRequestContext(context.awsRequestId, async () => {
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
