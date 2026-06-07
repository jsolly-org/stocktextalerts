import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSRecord } from "aws-lambda";
import { DateTime } from "luxon";
import { type AssetEventProvider, fetchAndStoreAssetEvents } from "../asset-events/fetch";
import { readEnv } from "../db/env";
import type { Logger } from "../logging";
import {
	dailyBarsToCloseRows,
	type PriceHistoryRow,
	storeDailyCloseRows,
	storePriceHistoryRows,
} from "../market-notifications/price-history-cache";
import { fetchDailyOHLCV } from "../providers/massive";
import { computeDeliveryRetryDelayMs } from "../providers/vendor-fault-tolerance";
import type { SupabaseAdminClient } from "../schedule/helpers";

/** Max SQS receive attempts before redrive to poison DLQ (matches template maxReceiveCount). */
export const VENDOR_BACKFILL_MAX_ATTEMPTS = 5;

type AssetEventsBackfillMessage = {
	kind: "asset-events";
	weekStart: string;
	weekEnd: string;
	providers: AssetEventProvider[];
	reason?: string;
};

type DailyClosesBackfillMessage = {
	kind: "daily-closes";
	symbols: string[];
	from: string;
	to: string;
	reason?: string;
};

type PriceHistoryStoreBackfillMessage = {
	kind: "price-history-store";
	rows: PriceHistoryRow[];
	reason?: string;
};

type NewSymbolWarmupBackfillMessage = {
	kind: "new-symbol-warmup";
	symbol: string;
	reason?: string;
};

type VendorBackfillMessage =
	| AssetEventsBackfillMessage
	| DailyClosesBackfillMessage
	| PriceHistoryStoreBackfillMessage
	| NewSymbolWarmupBackfillMessage;

type VendorBackfillBatchFailure = {
	itemIdentifier: string;
};

let sqsClient: SQSClient | undefined;

function getSqsClient(): SQSClient {
	if (!sqsClient) {
		sqsClient = new SQSClient({});
	}
	return sqsClient;
}

function getQueueUrl(): string | undefined {
	return readEnv("VENDOR_BACKFILL_QUEUE_URL");
}

function isAssetEventProvider(value: unknown): value is AssetEventProvider {
	return value === "earnings" || value === "dividends" || value === "splits" || value === "ipos";
}

function parsePriceHistoryRow(value: unknown): PriceHistoryRow | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.symbol !== "string" || typeof row.captured_at !== "string") {
		return null;
	}
	if (typeof row.price !== "number" || !Number.isFinite(row.price)) {
		return null;
	}
	return {
		symbol: row.symbol,
		price: row.price,
		captured_at: row.captured_at,
	};
}

export function parseVendorBackfillMessage(body: string): VendorBackfillMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const kind = record.kind;
	if (kind === "asset-events") {
		if (
			typeof record.weekStart !== "string" ||
			typeof record.weekEnd !== "string" ||
			!Array.isArray(record.providers) ||
			record.providers.length === 0 ||
			!record.providers.every(isAssetEventProvider)
		) {
			return null;
		}
		return {
			kind: "asset-events",
			weekStart: record.weekStart,
			weekEnd: record.weekEnd,
			providers: record.providers,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	if (kind === "daily-closes") {
		if (
			!Array.isArray(record.symbols) ||
			record.symbols.length === 0 ||
			typeof record.from !== "string" ||
			typeof record.to !== "string" ||
			!record.symbols.every((s) => typeof s === "string")
		) {
			return null;
		}
		return {
			kind: "daily-closes",
			symbols: record.symbols,
			from: record.from,
			to: record.to,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	if (kind === "price-history-store") {
		if (!Array.isArray(record.rows) || record.rows.length === 0) {
			return null;
		}
		const rows: PriceHistoryRow[] = [];
		for (const row of record.rows) {
			const parsedRow = parsePriceHistoryRow(row);
			if (!parsedRow) return null;
			rows.push(parsedRow);
		}
		return {
			kind: "price-history-store",
			rows,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	if (kind === "new-symbol-warmup") {
		if (typeof record.symbol !== "string" || record.symbol.trim() === "") {
			return null;
		}
		return {
			kind: "new-symbol-warmup",
			symbol: record.symbol.trim().toUpperCase(),
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	return null;
}

async function sendVendorBackfillMessage(message: VendorBackfillMessage): Promise<boolean> {
	const queueUrl = getQueueUrl();
	if (!queueUrl) {
		return false;
	}
	try {
		await getSqsClient().send(
			new SendMessageCommand({
				QueueUrl: queueUrl,
				MessageBody: JSON.stringify(message),
			}),
		);
		return true;
	} catch {
		return false;
	}
}

export async function enqueueAssetEventsIngestRetry(
	message: Omit<AssetEventsBackfillMessage, "kind">,
): Promise<boolean> {
	return sendVendorBackfillMessage({ kind: "asset-events", ...message });
}

export async function enqueueDailyCloseBackfill(
	message: Omit<DailyClosesBackfillMessage, "kind">,
): Promise<boolean> {
	return sendVendorBackfillMessage({ kind: "daily-closes", ...message });
}

export async function enqueuePriceHistoryStoreRetry(
	message: Omit<PriceHistoryStoreBackfillMessage, "kind">,
): Promise<boolean> {
	return sendVendorBackfillMessage({ kind: "price-history-store", ...message });
}

export async function enqueueNewSymbolWarmup(
	message: Omit<NewSymbolWarmupBackfillMessage, "kind">,
): Promise<boolean> {
	return sendVendorBackfillMessage({ kind: "new-symbol-warmup", ...message });
}

function getReceiveCount(record: SQSRecord): number {
	const raw = record.attributes?.ApproximateReceiveCount;
	const parsed = raw ? Number.parseInt(raw, 10) : 1;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

async function applyBackoff(record: SQSRecord, receiveCount: number): Promise<void> {
	const queueUrl = getQueueUrl();
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

async function backfillDailyClosesForSymbol(
	supabase: SupabaseAdminClient,
	symbol: string,
	from: string,
	to: string,
): Promise<boolean> {
	const bars = await fetchDailyOHLCV(symbol, from, to);
	if (!bars || bars.length === 0) {
		return true;
	}
	const rows = dailyBarsToCloseRows(symbol, bars);
	if (rows.length === 0) {
		return true;
	}
	return storeDailyCloseRows(supabase, rows);
}

async function processNewSymbolWarmup(
	supabase: SupabaseAdminClient,
	symbol: string,
	logger: Logger,
): Promise<{ ok: boolean; failedProviders: string[] }> {
	const thisMonday = DateTime.utc().startOf("week");
	const nextMonday = thisMonday.plus({ weeks: 1 });
	const weeks = [
		{
			weekStart: thisMonday.toISODate(),
			weekEnd: thisMonday.plus({ days: 4 }).toISODate(),
		},
		{
			weekStart: nextMonday.toISODate(),
			weekEnd: nextMonday.plus({ days: 4 }).toISODate(),
		},
	];

	const failedProviders: string[] = [];
	for (const week of weeks) {
		if (!week.weekStart || !week.weekEnd) continue;
		const result = await fetchAndStoreAssetEvents({
			supabase,
			weekStart: week.weekStart,
			weekEnd: week.weekEnd,
			logger,
		});
		failedProviders.push(...result.failedProviders);
	}

	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const dailyOk = await backfillDailyClosesForSymbol(supabase, symbol, from, to);

	return {
		ok: failedProviders.length === 0 && dailyOk,
		failedProviders,
	};
}

async function processVendorBackfillMessage(
	message: VendorBackfillMessage,
	supabase: SupabaseAdminClient,
	logger: Logger,
): Promise<boolean> {
	switch (message.kind) {
		case "asset-events": {
			const result = await fetchAndStoreAssetEvents({
				supabase,
				weekStart: message.weekStart,
				weekEnd: message.weekEnd,
				providers: message.providers,
				logger,
			});
			return result.failedProviders.length === 0;
		}
		case "daily-closes": {
			let allOk = true;
			for (const symbol of message.symbols) {
				const ok = await backfillDailyClosesForSymbol(supabase, symbol, message.from, message.to);
				if (!ok) allOk = false;
			}
			return allOk;
		}
		case "price-history-store": {
			return storePriceHistoryRows(supabase, message.rows);
		}
		case "new-symbol-warmup": {
			const result = await processNewSymbolWarmup(supabase, message.symbol, logger);
			return result.ok;
		}
		default: {
			const _exhaustive: never = message;
			return _exhaustive;
		}
	}
}

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
					await applyBackoff(record, receiveCount);
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

			await applyBackoff(record, receiveCount);
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
					await applyBackoff(record, receiveCount);
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
