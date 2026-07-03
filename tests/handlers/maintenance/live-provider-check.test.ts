import type { Context, ScheduledEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsoleError } from "../../setup";

// The handler is thin orchestration over the real provider clients; mock those
// so we can assert the pass/fail aggregation + paging behavior deterministically.
vi.mock("../../../src/lib/market-data/bars", () => ({
	fetchPrevClose: vi.fn(),
	fetchDailyCloses: vi.fn(),
}));
vi.mock("../../../src/lib/asset-events/earnings", () => ({
	fetchEarnings: vi.fn(),
}));
vi.mock("../../../src/lib/market-data/prices", () => ({
	fetchAssetPrices: vi.fn(),
}));
vi.mock("../../../src/lib/market-data/session", () => ({
	getCurrentMarketSession: vi.fn(),
}));
// The telegram:get-me check hits the real Bot API (getMe/getWebhookInfo); stub the
// read-only health check + bot construction so the suite never makes a live call.
vi.mock("../../../src/lib/messaging/telegram/health", () => ({
	checkTelegramLive: vi.fn(),
}));
vi.mock("../../../src/lib/messaging/telegram/sender", () => ({
	createTelegramBot: vi.fn(() => ({})),
	readTelegramBotToken: vi.fn(() => "test-telegram-bot-token"),
}));
// Partial mock: keep the REAL chart pipeline (the happy path proves the genuine WASM
// render works) but wrap renderChartPng in a spy so the red path can force a null
// render without stubbing the whole module.
vi.mock("../../../src/lib/messaging/parts/charts/candlestick", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/lib/messaging/parts/charts/candlestick")>();
	return { ...actual, renderChartPng: vi.fn(actual.renderChartPng) };
});

import { handler } from "../../../src/handlers/maintenance/live-provider-check";
import { fetchEarnings } from "../../../src/lib/asset-events/earnings";
import { fetchDailyCloses, fetchPrevClose } from "../../../src/lib/market-data/bars";
import { fetchAssetPrices } from "../../../src/lib/market-data/prices";
import { getCurrentMarketSession } from "../../../src/lib/market-data/session";
import { renderChartPng } from "../../../src/lib/messaging/parts/charts/candlestick";
import { checkTelegramLive } from "../../../src/lib/messaging/telegram/health";

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
	vi.mocked(checkTelegramLive).mockResolvedValue({
		ok: true,
		botId: 12345,
		username: "StockTextAlertsBot",
		webhookUrl: "",
		pendingUpdateCount: 0,
		lastError: null,
	});
}

describe("live-provider-check Lambda", () => {
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

	// The regression this whole change fixes: a stalled Telegram probe must page the
	// operator fast, not burn the 300s ceiling silently. checkTelegramLive now rejects
	// on timeout; assert the handler turns that rejection into a thrown page.
	it("A stalled Telegram probe fails the check and pages instead of hanging", async () => {
		vi.mocked(checkTelegramLive).mockRejectedValue(
			new Error("Telegram health check timed out after 12000 ms"),
		);
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/telegram:get-me/);
	});

	// The chart check exists to turn silent text-only degradation red post-deploy —
	// this pins that a failed render actually propagates to a thrown page, so the
	// guard can't be silently defused (swallowed probe, loosened assertion) later.
	it("A chart render failure (e.g. assets missing from the bundle) fails the check and pages", async () => {
		vi.mocked(renderChartPng).mockResolvedValueOnce(null);
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/chart:render-png/);
	});

	it("An invalid bot token (getMe returns no bot id) fails the check and pages", async () => {
		vi.mocked(checkTelegramLive).mockResolvedValue({
			ok: false,
			botId: 0,
			username: "",
			webhookUrl: "",
			pendingUpdateCount: 0,
			lastError: null,
		});
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/telegram:get-me/);
	});
});
