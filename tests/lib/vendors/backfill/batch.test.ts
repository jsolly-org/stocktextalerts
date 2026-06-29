import type { SQSRecord } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAndStoreAssetEvents } from "../../../../src/lib/asset-events/fetch";
import {
	handleVendorBackfillBatch,
	parseVendorBackfillMessage,
	VENDOR_BACKFILL_MAX_ATTEMPTS,
} from "../../../../src/lib/vendors/backfill/batch";

vi.mock("../../../../src/lib/asset-events/fetch", () => ({
	fetchAndStoreAssetEvents: vi.fn(),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
	SQSClient: vi.fn(() => ({ send: vi.fn() })),
	ChangeMessageVisibilityCommand: vi.fn((input) => input),
	SendMessageCommand: vi.fn((input) => input),
}));

function makeRecord(body: string, receiveCount = "1"): SQSRecord {
	return {
		messageId: "msg-1",
		receiptHandle: "rh-1",
		body,
		attributes: {
			ApproximateReceiveCount: receiveCount,
		},
	} as SQSRecord;
}

describe("vendor backfill queue", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("parses asset-events messages", () => {
		const parsed = parseVendorBackfillMessage(
			JSON.stringify({
				kind: "asset-events",
				weekStart: "2026-06-02",
				weekEnd: "2026-06-06",
				providers: ["earnings"],
			}),
		);
		expect(parsed).toEqual({
			kind: "asset-events",
			weekStart: "2026-06-02",
			weekEnd: "2026-06-06",
			providers: ["earnings"],
		});
	});

	it("rejects invalid message bodies", () => {
		expect(parseVendorBackfillMessage("{")).toBeNull();
		expect(parseVendorBackfillMessage(JSON.stringify({ kind: "asset-events" }))).toBeNull();
	});

	it("returns no failures when asset-events retry succeeds", async () => {
		vi.mocked(fetchAndStoreAssetEvents).mockResolvedValue({
			upserted: 1,
			failedProviders: [],
		});

		const failures = await handleVendorBackfillBatch({
			records: [
				makeRecord(
					JSON.stringify({
						kind: "asset-events",
						weekStart: "2026-06-02",
						weekEnd: "2026-06-06",
						providers: ["earnings"],
					}),
				),
			],
			supabase: {} as never,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			} as never,
		});

		expect(failures).toEqual([]);
	});

	it("reports batch failure and logs terminal exhaustion", async () => {
		vi.mocked(fetchAndStoreAssetEvents).mockResolvedValue({
			upserted: 0,
			failedProviders: ["earnings"],
		});
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		};

		const failures = await handleVendorBackfillBatch({
			records: [
				makeRecord(
					JSON.stringify({
						kind: "asset-events",
						weekStart: "2026-06-02",
						weekEnd: "2026-06-06",
						providers: ["earnings"],
					}),
					String(VENDOR_BACKFILL_MAX_ATTEMPTS),
				),
			],
			supabase: {} as never,
			logger: logger as never,
		});

		expect(failures).toEqual([{ itemIdentifier: "msg-1" }]);
		expect(logger.error).toHaveBeenCalledWith(
			"Vendor backfill exhausted retries",
			expect.objectContaining({
				category: "vendor_retry_exhausted",
				kind: "asset-events",
			}),
			expect.any(Error),
		);
	});
});
