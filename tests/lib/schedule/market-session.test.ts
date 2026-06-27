import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/market-data/session", () => ({
	getCurrentMarketSession: vi.fn(),
}));

import { getCurrentMarketSession } from "../../../src/lib/market-data/session";
import {
	__resetMarketSessionCacheForTests,
	resolveMarketSessionWithFallback,
} from "../../../src/lib/schedule/market-session";

const mockGet = vi.mocked(getCurrentMarketSession);

describe("resolveMarketSessionWithFallback", () => {
	beforeEach(() => {
		__resetMarketSessionCacheForTests();
		mockGet.mockReset();
	});

	it("A successful resolve returns the live session and is not degraded", async () => {
		mockGet.mockResolvedValue("regular");
		const result = await resolveMarketSessionWithFallback(1_000);
		expect(result).toEqual({ session: "regular", degraded: false });
	});

	it("A Massive blip within 10 minutes reuses the last good session, marked degraded", async () => {
		mockGet.mockResolvedValueOnce("after");
		await resolveMarketSessionWithFallback(1_000); // seeds cache at t=1s

		mockGet.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(60_000); // 59s later
		expect(result).toEqual({ session: "after", degraded: true });
	});

	it("A failure with no fresh cache defaults to closed (safe: skips price capture, no crash)", async () => {
		mockGet.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(1_000);
		expect(result).toEqual({ session: "closed", degraded: true });
	});

	it("A stale cache older than 10 minutes is not reused", async () => {
		mockGet.mockResolvedValueOnce("regular");
		await resolveMarketSessionWithFallback(1_000);

		mockGet.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(1_000 + 11 * 60_000);
		expect(result).toEqual({ session: "closed", degraded: true });
	});
});
