import { describe, expect, it, vi } from "vitest";
import {
	executeGetQuotes,
	GET_QUOTES_MAX_SYMBOLS,
} from "../../../../src/lib/market-notifications/flat-alerts/why-quotes";
import { NO_SESSION_TRADE } from "../../../../src/lib/types";

const getCurrentEquityTradeSession = vi.hoisted(() => vi.fn());
const fetchSnapshotQuotes = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/lib/market-data/session", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/market-data/session")>();
	return { ...actual, getCurrentEquityTradeSession };
});

vi.mock("../../../../src/lib/market-data/quotes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/market-data/quotes")>();
	return { ...actual, fetchSnapshotQuotes };
});

describe("executeGetQuotes", () => {
	it("rejects more than the symbol cap without fetching", async () => {
		const symbols = Array.from({ length: GET_QUOTES_MAX_SYMBOLS + 1 }, (_, i) => `T${i}`);
		const result = await executeGetQuotes(JSON.stringify({ symbols }));
		expect(result).toEqual({ error: `at most ${GET_QUOTES_MAX_SYMBOLS} symbols per call` });
	});

	it("rejects invalid JSON as an error object, not a flat tape", async () => {
		expect(await executeGetQuotes("not-json")).toEqual({ error: "invalid JSON arguments" });
	});

	it("returns { error } when the equity session is closed", async () => {
		getCurrentEquityTradeSession.mockResolvedValueOnce("closed");
		expect(await executeGetQuotes(JSON.stringify({ symbols: ["AAPL"] }))).toEqual({
			error: "market session is closed; quotes unavailable",
		});
		expect(fetchSnapshotQuotes).not.toHaveBeenCalled();
	});

	it("returns { error } when snapshot fetch throws", async () => {
		getCurrentEquityTradeSession.mockResolvedValueOnce("regular");
		fetchSnapshotQuotes.mockRejectedValueOnce(new Error("massive down"));
		expect(await executeGetQuotes(JSON.stringify({ symbols: ["AAPL"] }))).toEqual({
			error: "massive down",
		});
	});

	it("returns { error } per symbol for NO_SESSION_TRADE, never a fake tape", async () => {
		getCurrentEquityTradeSession.mockResolvedValueOnce("pre");
		fetchSnapshotQuotes.mockResolvedValueOnce(new Map([["AAPL", NO_SESSION_TRADE]]));
		expect(await executeGetQuotes(JSON.stringify({ symbols: ["AAPL"] }))).toEqual({
			quotes: { AAPL: { error: "no session trade" } },
		});
	});
});
