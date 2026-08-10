import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/market-data/session", () => ({
	getCurrentMarketSession: vi.fn(),
	getCurrentEquityTradeSession: vi.fn(),
}));

import {
	getCurrentEquityTradeSession,
	getCurrentMarketSession,
} from "../../../src/lib/market-data/session";
import { resolveMarketSessionWithFallback } from "../../../src/lib/schedule/market-session";
import { resetMarketSessionCache } from "../../helpers/reset-market-session-cache";

const mockGetHuman = vi.mocked(getCurrentMarketSession);
const mockGetEquity = vi.mocked(getCurrentEquityTradeSession);

describe("resolveMarketSessionWithFallback", () => {
	beforeEach(() => {
		resetMarketSessionCache();
		mockGetHuman.mockReset();
		mockGetEquity.mockReset();
	});

	it("A successful resolve returns the live human + equity sessions and is not degraded", async () => {
		mockGetHuman.mockResolvedValue("closed");
		mockGetEquity.mockResolvedValue("pre");
		const result = await resolveMarketSessionWithFallback(1_000);
		expect(result).toEqual({
			humanSession: "closed",
			equitySession: "pre",
			degraded: false,
		});
	});

	it("A Massive blip within 10 minutes reuses the last good pair, marked degraded", async () => {
		mockGetHuman.mockResolvedValueOnce("after");
		mockGetEquity.mockResolvedValueOnce("after");
		await resolveMarketSessionWithFallback(1_000); // seeds cache at t=1s

		mockGetHuman.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(60_000); // 59s later
		expect(result).toEqual({
			humanSession: "after",
			equitySession: "after",
			degraded: true,
		});
	});

	it("A failure with no fresh cache defaults to closed/closed (safe: skips price capture, no crash)", async () => {
		mockGetHuman.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(1_000);
		expect(result).toEqual({
			humanSession: "closed",
			equitySession: "closed",
			degraded: true,
		});
	});

	it("A stale cache older than 10 minutes is not reused", async () => {
		mockGetHuman.mockResolvedValueOnce("regular");
		mockGetEquity.mockResolvedValueOnce("regular");
		await resolveMarketSessionWithFallback(1_000);

		mockGetHuman.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(1_000 + 11 * 60_000);
		expect(result).toEqual({
			humanSession: "closed",
			equitySession: "closed",
			degraded: true,
		});
	});
});
