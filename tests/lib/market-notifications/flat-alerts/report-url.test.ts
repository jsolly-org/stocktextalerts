import { describe, expect, it } from "vitest";
import {
	buildPriceMoveReportPath,
	buildPriceMoveReportUrl,
} from "../../../../src/lib/market-notifications/flat-alerts/report-url";

describe("buildPriceMoveReportUrl", () => {
	it("builds an auth-gated path under /dashboard/price-move", () => {
		expect(buildPriceMoveReportPath("AAPL")).toBe("/dashboard/price-move/AAPL");
		expect(buildPriceMoveReportUrl("AAPL")).toBe("http://localhost/dashboard/price-move/AAPL");
	});

	it("keeps dotted tickers intact", () => {
		expect(buildPriceMoveReportPath("BRK.B")).toBe("/dashboard/price-move/BRK.B");
		expect(buildPriceMoveReportUrl("BRK.B")).toBe("http://localhost/dashboard/price-move/BRK.B");
	});
});
