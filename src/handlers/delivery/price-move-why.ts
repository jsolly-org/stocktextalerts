/**
 * SQS consumer for price-move alert "why" jobs: one message per (user, symbol)
 * reservation. Generates an optional Grok why blurb, delivers the alert, then
 * finalize/release. Batch size 1 with ReportBatchItemFailures.
 */
import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { RELEASE_ID } from "../../lib/logging/release-id";
import { runLambda } from "../../lib/logging/request-context";
import { processPriceMoveWhyAlert } from "../../lib/market-notifications/flat-alerts/why-job";
import { parsePriceMoveWhyMessage } from "../../lib/market-notifications/flat-alerts/why-queue";

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "price-move-why",
		});
		logger.info("Price-move why batch invoke", {
			action: "price_move_why_invoke",
			recordCount: event.Records.length,
			releaseId: RELEASE_ID,
		});

		const supabase = createSupabaseAdminClient();
		const batchItemFailures: { itemIdentifier: string }[] = [];

		for (const record of event.Records) {
			const message = parsePriceMoveWhyMessage(record.body);
			if (!message) {
				logger.error(
					"Invalid price-move why message",
					{
						action: "price_move_why",
						messageId: record.messageId,
					},
					new Error("Invalid message body"),
				);
				// Poison / malformed — do not retry forever; ack by omitting from failures
				// would hide bugs. Report failure so maxReceiveCount → DLQ.
				batchItemFailures.push({ itemIdentifier: record.messageId });
				continue;
			}

			try {
				await processPriceMoveWhyAlert({ supabase, message, logger });
			} catch (error) {
				logger.error(
					"Price-move why message processing failed",
					{
						action: "price_move_why",
						messageId: record.messageId,
						userId: message.userId,
						symbol: message.symbol,
					},
					error,
				);
				batchItemFailures.push({ itemIdentifier: record.messageId });
			}
		}

		return { batchItemFailures };
	});
}
