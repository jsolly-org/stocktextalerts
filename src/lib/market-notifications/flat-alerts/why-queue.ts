import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { readEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import { type ActiveMarketSession, isActiveMarketSession, isRecord } from "../../types";

type PriceMoveWhyQueueQuote = {
	price: number;
	prevClose: number | null;
	dayOpen?: number | null;
	changePercent?: number | null;
};

export type PriceMoveWhyMessage = {
	kind: "price-move-why";
	userId: string;
	symbol: string;
	companyName: string;
	quote: PriceMoveWhyQueueQuote;
	baseline: number;
	triggerPercent: number;
	thresholdValue: number;
	sessionPercent: number | null;
	isReTrigger: boolean;
	isAcceleration: boolean;
	lastNotificationAt: string | null;
	iconUrl: string | null;
	reason?: string;
	/** Schedule tick session. Required for lambda wakeup; optional on in-flight messages. */
	session?: ActiveMarketSession;
};

let sqsClient: SQSClient | undefined;

function getSqsClient(): SQSClient {
	if (!sqsClient) {
		sqsClient = new SQSClient({});
	}
	return sqsClient;
}

function getPriceMoveWhyQueueUrl(): string | undefined {
	return readEnv("PRICE_MOVE_WHY_QUEUE_URL");
}

function parseFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function parseOptionalFiniteNumber(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	return parseFiniteNumber(value);
}

/** Parse an SQS body into a price-move why job, or null when invalid. */
export function parsePriceMoveWhyMessage(body: string): PriceMoveWhyMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed.kind !== "price-move-why") return null;

	const userId = typeof parsed.userId === "string" ? parsed.userId : null;
	const symbol = typeof parsed.symbol === "string" ? parsed.symbol.trim().toUpperCase() : null;
	const companyName = typeof parsed.companyName === "string" ? parsed.companyName : null;
	if (!userId || !symbol || companyName === null) return null;

	if (!isRecord(parsed.quote)) return null;
	const price = parseFiniteNumber(parsed.quote.price);
	if (price === null) return null;
	const prevClose =
		parsed.quote.prevClose === null || parsed.quote.prevClose === undefined
			? ((parsed.quote.prevClose as null | undefined) ?? null)
			: parseFiniteNumber(parsed.quote.prevClose);
	if (
		prevClose === null &&
		parsed.quote.prevClose !== null &&
		parsed.quote.prevClose !== undefined
	) {
		return null;
	}

	const baseline = parseFiniteNumber(parsed.baseline);
	const triggerPercent = parseFiniteNumber(parsed.triggerPercent);
	if (baseline === null || triggerPercent === null) return null;

	if (typeof parsed.isReTrigger !== "boolean" || typeof parsed.isAcceleration !== "boolean") {
		return null;
	}

	const lastNotificationAt =
		parsed.lastNotificationAt === null
			? null
			: typeof parsed.lastNotificationAt === "string"
				? parsed.lastNotificationAt
				: null;
	if (parsed.lastNotificationAt !== null && lastNotificationAt === null) {
		return null;
	}

	const iconUrl =
		parsed.iconUrl === null ? null : typeof parsed.iconUrl === "string" ? parsed.iconUrl : null;
	if (parsed.iconUrl !== null && parsed.iconUrl !== undefined && iconUrl === null) {
		return null;
	}

	const dayOpen = parseOptionalFiniteNumber(parsed.quote.dayOpen);
	const changePercent = parseOptionalFiniteNumber(parsed.quote.changePercent);
	const session =
		typeof parsed.session === "string" && isActiveMarketSession(parsed.session)
			? parsed.session
			: undefined;

	return {
		kind: "price-move-why",
		userId,
		symbol,
		companyName,
		quote: {
			price,
			prevClose: prevClose ?? null,
			...(dayOpen !== undefined ? { dayOpen } : {}),
			...(changePercent !== undefined ? { changePercent } : {}),
		},
		baseline,
		triggerPercent,
		thresholdValue: parseFiniteNumber(parsed.thresholdValue) ?? 5,
		sessionPercent: parseOptionalFiniteNumber(parsed.sessionPercent) ?? null,
		isReTrigger: parsed.isReTrigger,
		isAcceleration: parsed.isAcceleration,
		lastNotificationAt,
		iconUrl,
		reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		...(session !== undefined ? { session } : {}),
	};
}

/** Enqueue a price-move why job. Returns false when the queue URL is missing or send fails. */
export async function enqueuePriceMoveWhy(
	message: Omit<PriceMoveWhyMessage, "kind"> & { kind?: "price-move-why" },
): Promise<boolean> {
	const queueUrl = getPriceMoveWhyQueueUrl();
	if (!queueUrl) {
		return false;
	}

	const body: PriceMoveWhyMessage = {
		kind: "price-move-why",
		userId: message.userId,
		symbol: message.symbol,
		companyName: message.companyName,
		quote: message.quote,
		baseline: message.baseline,
		triggerPercent: message.triggerPercent,
		thresholdValue: message.thresholdValue,
		sessionPercent: message.sessionPercent,
		isReTrigger: message.isReTrigger,
		isAcceleration: message.isAcceleration,
		lastNotificationAt: message.lastNotificationAt,
		iconUrl: message.iconUrl,
		reason: message.reason,
		...(message.session !== undefined ? { session: message.session } : {}),
	};

	try {
		await getSqsClient().send(
			new SendMessageCommand({
				QueueUrl: queueUrl,
				MessageBody: JSON.stringify(body),
			}),
		);
		return true;
	} catch (error) {
		rootLogger.warn(
			"Failed to enqueue price-move why job",
			{ userId: body.userId, symbol: body.symbol },
			error,
		);
		return false;
	}
}
