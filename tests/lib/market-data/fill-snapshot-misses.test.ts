import { afterEach, describe, expect, it, vi } from "vitest";
import { fillSnapshotMissesWithPrevDayBar } from "../../../src/lib/market-data/prices";
import type { ExtendedAssetQuote, NoSessionTrade } from "../../../src/lib/types";
import { expectConsoleError } from "../../setup";

vi.mock("../../../src/lib/market-data/quotes", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/quotes")>(
		"../../../src/lib/market-data/quotes",
	);
	return {
		...actual,
		fetchPrevDayBar: vi.fn(),
	};
});

const { fetchPrevDayBar } = await import("../../../src/lib/market-data/quotes");
const fetchPrevDayBarMock = vi.mocked(fetchPrevDayBar);

afterEach(() => {
	fetchPrevDayBarMock.mockReset();
});

type SnapshotMap = Map<string, ExtendedAssetQuote | NoSessionTrade | null>;

function makePrevDayBar(price: number): ExtendedAssetQuote {
	return {
		price,
		changePercent: 0,
		prevClose: null,
		timestamp: 1_715_817_600,
		dayHigh: price * 1.01,
		dayLow: price * 0.99,
		dayOpen: price * 0.995,
		volume: 1_234_567,
	};
}

describe("fillSnapshotMissesWithPrevDayBar closed-session backfill", () => {
	it("backfills every closed-session no_session_trade entry with a prev-day bar", async () => {
		const tickers = ["NVDA", "AMZN", "BA", "MSTR", "GOOGL", "UNH", "JPM", "PG", "FIG", "TSLA"];
		const closes: Record<string, number> = {
			NVDA: 952.83,
			AMZN: 222.71,
			BA: 189.45,
			MSTR: 412.06,
			GOOGL: 186.93,
			UNH: 543.18,
			JPM: 273.94,
			PG: 165.22,
			FIG: 78.41,
			TSLA: 358.6,
		};
		const snapshot: SnapshotMap = new Map(tickers.map((ticker) => [ticker, "no_session_trade"]));
		fetchPrevDayBarMock.mockImplementation(async (symbol: string) =>
			makePrevDayBar(closes[symbol] ?? 100),
		);

		await fillSnapshotMissesWithPrevDayBar(tickers, snapshot, "closed");

		expect(fetchPrevDayBarMock).toHaveBeenCalledTimes(tickers.length);
		for (const ticker of tickers) {
			const entry = snapshot.get(ticker);
			expect(entry).not.toBe("no_session_trade");
			expect(entry).not.toBeNull();
			expect(entry).toMatchObject({
				price: closes[ticker],
				prevClose: null,
			});
		}
	});

	it("backfills null and no_session_trade while preserving live quotes", async () => {
		const tickers = ["NVDA", "AMZN", "DELISTED"];
		const liveQuote: ExtendedAssetQuote = {
			price: 950.12,
			changePercent: 1.4,
			prevClose: 936.99,
			dayHigh: null,
			dayLow: null,
			dayOpen: null,
			timestamp: null,
			volume: null,
		};
		const snapshot = new Map<string, ExtendedAssetQuote | NoSessionTrade | null>([
			["NVDA", liveQuote],
			["AMZN", "no_session_trade"],
			["DELISTED", null],
		]);
		fetchPrevDayBarMock.mockImplementation(async (symbol: string) =>
			symbol === "DELISTED" ? null : makePrevDayBar(222.71),
		);

		await fillSnapshotMissesWithPrevDayBar(tickers, snapshot, "closed");

		expect(snapshot.get("NVDA")).toEqual(liveQuote);
		expect(snapshot.get("AMZN")).toMatchObject({
			price: 222.71,
			prevClose: null,
		});
		expect(snapshot.get("DELISTED")).toBeNull();
		expect(fetchPrevDayBarMock).toHaveBeenCalledTimes(2);
	});

	it("does not backfill no_session_trade during the regular session", async () => {
		const tickers = ["NVDA", "ILLIQUID"];
		const snapshot = new Map<string, ExtendedAssetQuote | NoSessionTrade | null>([
			[
				"NVDA",
				{
					price: 950,
					changePercent: 1.4,
					prevClose: 937,
					dayHigh: null,
					dayLow: null,
					dayOpen: null,
					timestamp: null,
					volume: null,
				},
			],
			["ILLIQUID", "no_session_trade"],
		]);

		await fillSnapshotMissesWithPrevDayBar(tickers, snapshot, "regular");

		expect(snapshot.get("ILLIQUID")).toBe("no_session_trade");
		expect(fetchPrevDayBarMock).not.toHaveBeenCalled();
	});

	it("does not backfill null or no_session_trade during pre-market", async () => {
		const snapshot: SnapshotMap = new Map([
			["DELISTED", null],
			["NVDA", "no_session_trade"],
		]);

		await fillSnapshotMissesWithPrevDayBar(["DELISTED", "NVDA"], snapshot, "pre");

		expect(snapshot.get("DELISTED")).toBeNull();
		expect(snapshot.get("NVDA")).toBe("no_session_trade");
		expect(fetchPrevDayBarMock).not.toHaveBeenCalled();
	});

	it("turns a failed closed-session no_session_trade backfill into null", async () => {
		const snapshot: SnapshotMap = new Map([["DELISTED_FRIDAY_AFTER_CLOSE", "no_session_trade"]]);
		fetchPrevDayBarMock.mockResolvedValueOnce(null);

		await fillSnapshotMissesWithPrevDayBar(["DELISTED_FRIDAY_AFTER_CLOSE"], snapshot, "closed");

		expect(snapshot.get("DELISTED_FRIDAY_AFTER_CLOSE")).toBeNull();
	});

	it("sets a thrown closed-session backfill to null and logs it", async () => {
		const snapshot: SnapshotMap = new Map([["BROKEN_BACKFILL", "no_session_trade"]]);
		fetchPrevDayBarMock.mockRejectedValueOnce(new Error("Massive 502 on /v2/aggs/prev"));
		expectConsoleError("Prev-day-bar fallback failed");

		await fillSnapshotMissesWithPrevDayBar(["BROKEN_BACKFILL"], snapshot, "closed");

		expect(snapshot.get("BROKEN_BACKFILL")).toBeNull();
	});
});
