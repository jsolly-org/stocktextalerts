import { describe, expect, it } from "vitest";
import { renderPriceAlertHeadline } from "../../../../src/lib/messaging/parts/price-alert-sentences";

describe("renderPriceAlertHeadline renders a single-asset headline from structured facts", () => {
	it("renders an up move with 1-decimal change% and a grouped price", () => {
		expect(
			renderPriceAlertHeadline({
				symbol: "AAPL",
				changePercent: 2.5,
				price: 228.5,
				period: "today",
			}),
		).toBe("AAPL is up 2.5% today ($228.50)");
	});

	it("renders a down move (negative change%) with its magnitude", () => {
		expect(
			renderPriceAlertHeadline({
				symbol: "LDOS",
				changePercent: -11.1,
				price: 173.0,
				period: "today",
			}),
		).toBe("LDOS is down 11.1% today ($173.00)");
	});

	it("treats a flat move as up (>= 0) and rounds change% to 1 decimal", () => {
		expect(
			renderPriceAlertHeadline({ symbol: "MSFT", changePercent: 0, price: 416.5, period: "today" }),
		).toBe("MSFT is up 0.0% today ($416.50)");
	});

	it("carries the re-trigger period phrase and comma-groups four-figure prices", () => {
		expect(
			renderPriceAlertHeadline({
				symbol: "BRK.B",
				changePercent: 5.04,
				price: 1234.5,
				period: "since last alert (27 min ago)",
			}),
		).toBe("BRK.B is up 5.0% since last alert (27 min ago) ($1,234.50)");
	});
});
