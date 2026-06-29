import type { SQSRecord } from "aws-lambda";
import type { SupabaseAdminClient } from "../../db/supabase";
import type { Logger } from "../../logging";
import { VENDOR_BACKFILL_MAX_ATTEMPTS } from "./constants";
import { parseVendorBackfillMessage } from "./messages";
import { processVendorBackfillMessage } from "./process";
import { applyVendorBackfillBackoff, getReceiveCount } from "./sqs";

export type VendorBackfillBatchFailure = {
	itemIdentifier: string;
};

export { VENDOR_BACKFILL_MAX_ATTEMPTS } from "./constants";
export { parseVendorBackfillMessage } from "./messages";

export async function handleVendorBackfillBatch(options: {
	records: SQSRecord[];
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<VendorBackfillBatchFailure[]> {
	const { records, supabase, logger } = options;
	const failures: VendorBackfillBatchFailure[] = [];

	for (const record of records) {
		const receiveCount = getReceiveCount(record);
		const message = parseVendorBackfillMessage(record.body);
		if (!message) {
			logger.error(
				"Invalid vendor backfill message",
				{
					action: "vendor_backfill",
					messageId: record.messageId,
					receiveCount,
				},
				new Error("Invalid message body"),
			);
			if (receiveCount >= VENDOR_BACKFILL_MAX_ATTEMPTS) {
				failures.push({ itemIdentifier: record.messageId });
			} else {
				try {
					await applyVendorBackfillBackoff(record, receiveCount);
				} catch (error) {
					logger.error(
						"Failed to apply vendor backfill backoff for invalid message",
						{ action: "vendor_backfill", messageId: record.messageId },
						error,
					);
				}
				failures.push({ itemIdentifier: record.messageId });
			}
			continue;
		}

		try {
			const ok = await processVendorBackfillMessage(message, supabase, logger);
			if (ok) continue;

			if (receiveCount >= VENDOR_BACKFILL_MAX_ATTEMPTS) {
				logger.error(
					"Vendor backfill exhausted retries",
					{
						action: "vendor_backfill",
						category: "vendor_retry_exhausted",
						kind: message.kind,
						receiveCount,
						messageId: record.messageId,
					},
					new Error(`Vendor backfill failed after ${receiveCount} attempts`),
				);
				failures.push({ itemIdentifier: record.messageId });
				continue;
			}

			await applyVendorBackfillBackoff(record, receiveCount);
			failures.push({ itemIdentifier: record.messageId });
		} catch (error) {
			logger.error(
				"Vendor backfill message processing threw",
				{
					action: "vendor_backfill",
					kind: message.kind,
					receiveCount,
					messageId: record.messageId,
				},
				error,
			);
			if (receiveCount >= VENDOR_BACKFILL_MAX_ATTEMPTS) {
				failures.push({ itemIdentifier: record.messageId });
			} else {
				try {
					await applyVendorBackfillBackoff(record, receiveCount);
				} catch (backoffError) {
					logger.error(
						"Failed to apply vendor backfill backoff",
						{ action: "vendor_backfill", messageId: record.messageId },
						backoffError,
					);
				}
				failures.push({ itemIdentifier: record.messageId });
			}
		}
	}

	return failures;
}
