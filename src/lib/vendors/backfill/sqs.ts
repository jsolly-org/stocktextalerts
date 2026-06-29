import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSRecord } from "aws-lambda";
import { readEnv } from "../../db/env";
import { computeDeliveryRetryDelayMs } from "../../schedule/retry-delays";

let sqsClient: SQSClient | undefined;

function getSqsClient(): SQSClient {
	if (!sqsClient) {
		sqsClient = new SQSClient({});
	}
	return sqsClient;
}

function getVendorBackfillQueueUrl(): string | undefined {
	return readEnv("VENDOR_BACKFILL_QUEUE_URL");
}

export async function sendVendorBackfillMessage(body: string): Promise<boolean> {
	const queueUrl = getVendorBackfillQueueUrl();
	if (!queueUrl) {
		return false;
	}
	try {
		await getSqsClient().send(
			new SendMessageCommand({
				QueueUrl: queueUrl,
				MessageBody: body,
			}),
		);
		return true;
	} catch {
		return false;
	}
}

export function getReceiveCount(record: SQSRecord): number {
	const raw = record.attributes?.ApproximateReceiveCount;
	const parsed = raw ? Number.parseInt(raw, 10) : 1;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function applyVendorBackfillBackoff(
	record: SQSRecord,
	receiveCount: number,
): Promise<void> {
	const queueUrl = getVendorBackfillQueueUrl();
	if (!queueUrl) return;
	const delaySeconds = Math.ceil(computeDeliveryRetryDelayMs(receiveCount) / 1000);
	await getSqsClient().send(
		new ChangeMessageVisibilityCommand({
			QueueUrl: queueUrl,
			ReceiptHandle: record.receiptHandle,
			VisibilityTimeout: delaySeconds,
		}),
	);
}
