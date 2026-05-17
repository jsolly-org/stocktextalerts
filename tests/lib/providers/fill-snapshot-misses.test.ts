import { afterEach, describe, expect, it, vi } from "vitest";
import { fillSnapshotMissesWithPrevDayBar } from "../../../src/lib/providers/price-fetcher";
import { expectConsoleError } from "../../setup";

vi.mock("../../../src/lib/providers/massive", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/providers/massive")>(
		"../../../src/lib/providers/massive",
	);
	return {
		...actual,
		fetchPrevDayBar: vi.fn(),
	};
});

const { fetchPrevDayBar } = await import("../../../src/lib/providers/massive");
const fetchPrevDayBarMock = vi.mocked(fetchPrevDayBar);

afterEach(() => {
	fetchPrevDayBarMock.mockReset();
});

describe("fillSnapshotMissesWithPrevDayBar closed-session backfill", () => {
	it("Weekend digest: snapshot returns no_session_trade for blue-chip tickers; backfill fills every entry with prev-day bars", async () => {
		// Saturday for 10-ticker user — exactly the production case that fired
		// stocktextalerts-error-logs at 22:29 UTC on 2026-05-16.
		const tickers = ["NVDA", "AMZN", "BA", "MSTR", "GOOGL", "UNH", "JPM", "PG", "FIG", "TSLA"];
		const snapshot = new Map<string, "no_session_trade" | null | object>(
			tickers.map((t) => [t, "no_session_trade"]),
		);
		fetchPrevDayBarMock.mockImplementation(async (symbol: string) => ({
			price: 100,
			changePercent: 1.25,
			prevClose: 98.77,
			timestamp: 1_715_817_600,
			dayHigh: 101.5,
			dayLow: 98.5,
			dayOpen: 99.0,
			volume: 1_234_567,
			symbol,
		}));

		await fillSnapshotMissesWithPrevDayBar(tickers, snapshot, "closed");

		expect(fetchPrevDayBarMock).toHaveBeenCalledTimes(tickers.length);
		for (const t of tickers) {
			const entry = snapshot.get(t);
			expect(entry).not.toBe("no_session_trade");
			expect(entry).not.toBeNull();
			expect(entry).toMatchObject({ symbol: t, prevClose: 98.77 });
		}
	});

	it("Closed session with mixed snapshot: null and no_session_trade both get the prev-day fallback; live quotes are preserved", async () => {
		const tickers = ["NVDA", "AMZN", "DELISTED"];
		const liveQuote = { price: 950.12, changePercent: 1.4, prevClose: 936.99 };
		const snapshot = new Map<string, "no_session_trade" | null | object>([
			["NVDA", liveQuote],
			["AMZN", "no_session_trade"],
			["DELISTED", null],
		]);
		fetchPrevDayBarMock.mockImplementation(async (symbol: string) =>
			symbol === "DELISTED"
				? null
				: {
						symbol,
						price: 200,
						prevClose: 198.5,
						changePercent: 0.75,
						timestamp: 1,
						dayHigh: 201,
						dayLow: 199,
						dayOpen: 199.5,
						volume: 500,
					},
		);

		await fillSnapshotMissesWithPrevDayBar(tickers, snapshot, "closed");

		expect(snapshot.get("NVDA")).toEqual(liveQuote);
		expect(snapshot.get("AMZN")).toMatchObject({ symbol: "AMZN", price: 200 });
		expect(snapshot.get("DELISTED")).toBeNull();
		expect(fetchPrevDayBarMock).toHaveBeenCalledTimes(2);
	});

	it("Active regular session: no_session_trade entries stay as-is; no prev-day fallback fires", async () => {
		const tickers = ["NVDA", "ILLIQUID_AFTER_HOURS"];
		const snapshot = new Map<string, "no_session_trade" | null | object>([
			["NVDA", { price: 950, changePercent: 1.4, prevClose: 937 }],
			["ILLIQUID_AFTER_HOURS", "no_session_trade"],
		]);

		await fillSnapshotMissesWithPrevDayBar(tickers, snapshot, "regular");

		expect(snapshot.get("ILLIQUID_AFTER_HOURS")).toBe("no_session_trade");
		expect(fetchPrevDayBarMock).not.toHaveBeenCalled();
	});

	it("Pre-market session with null snapshot entry: no_session_trade meaning is preserved; prev-day fallback skipped on active session", async () => {
		const snapshot = new Map<string, "no_session_trade" | null | object>([
			["DELISTED", null],
			["NVDA", "no_session_trade"],
		]);

		await fillSnapshotMissesWithPrevDayBar(["DELISTED", "NVDA"], snapshot, "pre");

		expect(snapshot.get("DELISTED")).toBeNull();
		expect(snapshot.get("NVDA")).toBe("no_session_trade");
		expect(fetchPrevDayBarMock).not.toHaveBeenCalled();
	});

	it("Closed session backfill failure: no_session_trade entry whose prev-day-bar comes back null is overwritten with null so downstream classification routes it to 'missing', not 'expected illiquid'", async () => {
		// Regression for the reviewer-flagged silent-failure path: a delisted
		// ticker on a Saturday used to fire logger.error in the old code (via
		// narrowSnapshotToPriceMap's "no_session_trade"→null collapse). After
		// the refactor split the buckets, "no_session_trade" survived an
		// unsuccessful backfill and got mis-classified as expected-illiquid,
		// suppressing the page-worthy "prices missing" log.
		const snapshot = new Map<string, "no_session_trade" | null | object>([
			["DELISTED_FRIDAY_AFTER_CLOSE", "no_session_trade"],
		]);
		fetchPrevDayBarMock.mockResolvedValueOnce(null);

		await fillSnapshotMissesWithPrevDayBar(["DELISTED_FRIDAY_AFTER_CLOSE"], snapshot, "closed");

		expect(snapshot.get("DELISTED_FRIDAY_AFTER_CLOSE")).toBeNull();
		expect(snapshot.get("DELISTED_FRIDAY_AFTER_CLOSE")).not.toBe("no_session_trade");
	});

	it("Closed session: when fetchPrevDayBar throws, the entry is overwritten with null and the failure is logged", async () => {
		const snapshot = new Map<string, "no_session_trade" | null | object>([
			["BROKEN_BACKFILL", "no_session_trade"],
		]);
		fetchPrevDayBarMock.mockRejectedValueOnce(new Error("Massive 502 on /v2/aggs/prev"));
		expectConsoleError("Prev-day-bar fallback failed");

		await fillSnapshotMissesWithPrevDayBar(["BROKEN_BACKFILL"], snapshot, "closed");

		expect(snapshot.get("BROKEN_BACKFILL")).toBeNull();
	});
});
