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
	fetchAssetPricesWithSessionState: vi.fn(),
}));
vi.mock("../../../src/lib/market-data/session", () => ({
	getCurrentMarketSession: vi.fn(),
}));
vi.mock("../../../src/lib/assets/reference/universe", () => ({
	fetchActiveTickers: vi.fn(),
}));
vi.mock("../../../src/lib/assets/reference/ticker-detail", () => ({
	fetchTickerDetail: vi.fn(),
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
vi.mock("../../../src/lib/messaging/telegram/render-png", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/lib/messaging/telegram/render-png")>();
	return { ...actual, renderChartPng: vi.fn(actual.renderChartPng) };
});
vi.mock("../../../src/lib/vendors/polymarket", () => ({
	polymarketFetch: vi.fn(),
}));
vi.mock("../../../src/lib/vendors/kalshi", () => ({
	kalshiFetch: vi.fn(),
}));

import { handler } from "../../../src/handlers/maintenance/live-provider-check";
import { fetchEarnings } from "../../../src/lib/asset-events/earnings";
import { MIN_PLAUSIBLE_ACTIVE_UNIVERSE } from "../../../src/lib/assets/constants";
import { fetchTickerDetail } from "../../../src/lib/assets/reference/ticker-detail";
import { fetchActiveTickers } from "../../../src/lib/assets/reference/universe";
import type { ActiveUniverse } from "../../../src/lib/assets/types";
import { fetchDailyCloses, fetchPrevClose } from "../../../src/lib/market-data/bars";
import { fetchAssetPricesWithSessionState } from "../../../src/lib/market-data/prices";
import { getCurrentMarketSession } from "../../../src/lib/market-data/session";
import { checkTelegramLive } from "../../../src/lib/messaging/telegram/health";
import { renderChartPng } from "../../../src/lib/messaging/telegram/render-png";
import { kalshiFetch } from "../../../src/lib/vendors/kalshi";
import { polymarketFetch } from "../../../src/lib/vendors/polymarket";

const event = { id: "evt-1", time: "2026-06-13T16:00:00Z" } as ScheduledEvent;
const context = { awsRequestId: "test-request-id" } as Context;

/** A plausible full US listing — sized exactly at the floor so the >= assertion passes. */
function buildPlausibleUniverse(size = MIN_PLAUSIBLE_ACTIVE_UNIVERSE): ActiveUniverse {
	const tickers = Array.from({ length: size }, (_, i) => ({
		symbol: `TICK${i}`,
		name: `LISTED COMPANY ${i} INC`,
		type: "stock" as const,
	}));
	return { tickers, allActiveSymbols: new Set(tickers.map((t) => t.symbol)) };
}

function stubHealthyProviders(): void {
	vi.mocked(fetchPrevClose).mockResolvedValue(512.34);
	vi.mocked(getCurrentMarketSession).mockResolvedValue("regular");
	vi.mocked(fetchAssetPricesWithSessionState).mockResolvedValue({
		prices: new Map([
			["SPY", { price: 512.34, changePercent: 0.41 }],
			["AAPL", { price: 201.1, changePercent: -0.18 }],
		]) as Awaited<ReturnType<typeof fetchAssetPricesWithSessionState>>["prices"],
		noSessionTrade: new Set(),
	});
	vi.mocked(fetchDailyCloses).mockResolvedValue([510.1, 511.2, 512.3]);
	vi.mocked(fetchEarnings).mockResolvedValue({
		failed: false,
		data: [],
	} as Awaited<ReturnType<typeof fetchEarnings>>);
	vi.mocked(fetchActiveTickers).mockResolvedValue(buildPlausibleUniverse());
	vi.mocked(fetchTickerDetail).mockResolvedValue({
		ok: true,
		iconUrl: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AAPL.png",
	});
	vi.mocked(checkTelegramLive).mockResolvedValue({
		ok: true,
		botId: 12345,
		username: "SollyClawBot",
		webhookUrl: "",
		pendingUpdateCount: 0,
		lastError: null,
	});
	vi.mocked(polymarketFetch).mockResolvedValue({
		events: [{ title: "NVIDIA", slug: "nvidia", markets: [] }],
	});
	vi.mocked(kalshiFetch).mockImplementation(async (path: string) => {
		if (path === "/series") {
			return { series: [{ ticker: "KXTSLA", title: "Tesla" }], cursor: null };
		}
		return { markets: [{ ticker: "KXTSLA-26", title: "Tesla" }] };
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

	it("A full Finnhub quote outage (null/zero prices, right map size) still fails the check", async () => {
		// The fetcher pre-seeds every symbol to null, so `size === 2` would pass on a total
		// outage — the strengthened per-symbol finite-positive-price assertion must catch it.
		vi.mocked(fetchAssetPricesWithSessionState).mockResolvedValue({
			prices: new Map([
				["SPY", null],
				["AAPL", { price: 0, changePercent: 0 }],
			]) as Awaited<ReturnType<typeof fetchAssetPricesWithSessionState>>["prices"],
			noSessionTrade: new Set(),
		});
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/finnhub:asset-prices/);
	});

	it("A pre-market Finnhub free-tier stale trade timestamp (NO_SESSION_TRADE) still passes", async () => {
		// Post-deploy often lands outside regular hours. Free-tier `/quote` leaves `t` on
		// yesterday's close for liquid names → NO_SESSION_TRADE. That proves the endpoint
		// answered; only a true miss (null without the sentinel) should fail the deploy.
		vi.mocked(getCurrentMarketSession).mockResolvedValue("pre");
		vi.mocked(fetchAssetPricesWithSessionState).mockResolvedValue({
			prices: new Map([
				["SPY", null],
				["AAPL", null],
			]) as Awaited<ReturnType<typeof fetchAssetPricesWithSessionState>>["prices"],
			noSessionTrade: new Set(["SPY", "AAPL"]),
		});
		await expect(handler(event, context)).resolves.toBeUndefined();
	});

	it("A pre-market true quote miss (null without NO_SESSION_TRADE) still fails the check", async () => {
		vi.mocked(getCurrentMarketSession).mockResolvedValue("pre");
		vi.mocked(fetchAssetPricesWithSessionState).mockResolvedValue({
			prices: new Map([
				["SPY", null],
				["AAPL", { price: 201.1, changePercent: -0.18 }],
			]) as Awaited<ReturnType<typeof fetchAssetPricesWithSessionState>>["prices"],
			noSessionTrade: new Set(),
		});
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/finnhub:asset-prices/);
	});

	it("A truncated Finnhub stock-symbols listing (below the plausibility floor) fails the check", async () => {
		// A transport failure or truncated page yields far fewer than the ~11k real
		// listings — the floor assertion must catch it before Sunday's reconcile does.
		vi.mocked(fetchActiveTickers).mockResolvedValue(
			buildPlausibleUniverse(MIN_PLAUSIBLE_ACTIVE_UNIVERSE - 1),
		);
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/finnhub:stock-symbols/);
	});

	it("A Finnhub company-profile entitlement break (no AAPL logo) fails the check", async () => {
		// AAPL definitively has a logo, so ok-with-null means the entitlement or
		// response shape broke — not "no logo for this symbol".
		vi.mocked(fetchTickerDetail).mockResolvedValue({ ok: true, iconUrl: null });
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/finnhub:company-profile/);
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

	it("A Polymarket public-search outage fails the check and pages", async () => {
		vi.mocked(polymarketFetch).mockResolvedValue({ events: [] });
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/polymarket:public-search/);
	});

	it("A Kalshi Companies series outage fails the check and pages", async () => {
		vi.mocked(kalshiFetch).mockImplementation(async (path: string) => {
			if (path === "/series") return { series: [] };
			return { markets: [] };
		});
		expectConsoleError(/Live provider checks failed/);
		await expect(handler(event, context)).rejects.toThrow(/kalshi:companies-series/);
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
