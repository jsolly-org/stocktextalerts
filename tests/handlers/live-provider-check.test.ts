import type { Context, ScheduledEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsoleError } from "../setup";

// The handler is thin orchestration over the real provider clients; mock those
// so we can assert the pass/fail aggregation + paging behavior deterministically.
vi.mock("../../src/lib/providers/massive", () => ({
	fetchPrevClose: vi.fn(),
	fetchDailyCloses: vi.fn(),
	fetchEarnings: vi.fn(),
}));
vi.mock("../../src/lib/providers/price-fetcher", () => ({
	fetchAssetPrices: vi.fn(),
	getCurrentMarketSession: vi.fn(),
}));

import { handler } from "../../src/handlers/live-provider-check";
import { fetchDailyCloses, fetchEarnings, fetchPrevClose } from "../../src/lib/providers/massive";
import { fetchAssetPrices, getCurrentMarketSession } from "../../src/lib/providers/price-fetcher";

const event = { id: "evt-1", time: "2026-06-13T16:00:00Z" } as ScheduledEvent;
const context = { awsRequestId: "test-request-id" } as Context;

function stubHealthyProviders(): void {
	vi.mocked(fetchPrevClose).mockResolvedValue(512.34);
	vi.mocked(getCurrentMarketSession).mockResolvedValue("regular");
	vi.mocked(fetchAssetPrices).mockResolvedValue(
		new Map([
			["SPY", { price: 512.34, changePercent: 0.41 }],
			["AAPL", { price: 201.1, changePercent: -0.18 }],
		]) as Awaited<ReturnType<typeof fetchAssetPrices>>,
	);
	vi.mocked(fetchDailyCloses).mockResolvedValue([510.1, 511.2, 512.3]);
	vi.mocked(fetchEarnings).mockResolvedValue({
		failed: false,
		data: [],
	} as Awaited<ReturnType<typeof fetchEarnings>>);
}

describe("live-provider-check Lambda (replaces the live-provider-tests.yml cron)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		stubHealthyProviders();
	});

	it("A weekday mid-session check passes when Massive and Finnhub return fresh data", async () => {
		await expect(handler(event, context)).resolves.toBeUndefined();
	});

	it("A stale/empty Massive prev-close fails the check and pages via a thrown error", async () => {
		vi.mocked(fetchPrevClose).mockResolvedValue(null);
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/massive:prev-close/);
	});

	it("A Finnhub earnings-feed outage fails the check and pages", async () => {
		vi.mocked(fetchEarnings).mockResolvedValue({
			failed: true,
			data: [],
		} as Awaited<ReturnType<typeof fetchEarnings>>);
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/finnhub:earnings/);
	});
});
