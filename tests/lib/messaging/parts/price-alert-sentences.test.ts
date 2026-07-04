import { describe, expect, it } from "vitest";
import {
	renderPriceAlertHeadline,
	renderSignalSentence,
} from "../../../../src/lib/messaging/parts/price-alert-sentences";

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

describe("renderSignalSentence renders the user-facing signal from structured facts", () => {
	it("renders an up benchmark move at 2-decimal precision", () => {
		expect(
			renderSignalSentence({
				benchmarkLabel: "broader market (SPY)",
				benchmarkMovePercent: 0.85,
				hasEarningsNearby: false,
			}),
		).toBe("The broader market (SPY) moved up 0.85% today.");
	});

	it("renders a down benchmark move using the sign for direction", () => {
		expect(
			renderSignalSentence({
				benchmarkLabel: "Technology sector (XLK)",
				benchmarkMovePercent: -1.2,
				hasEarningsNearby: false,
			}),
		).toBe("The Technology sector (XLK) moved down 1.20% today.");
	});

	it("renders earnings proximity alone when the benchmark move is unknown", () => {
		expect(
			renderSignalSentence({
				benchmarkLabel: "broader market (SPY)",
				benchmarkMovePercent: null,
				hasEarningsNearby: true,
			}),
		).toBe("Earnings are expected within the next couple of days.");
	});

	it("joins benchmark and earnings sentences with a single space", () => {
		expect(
			renderSignalSentence({
				benchmarkLabel: "broader market (SPY)",
				benchmarkMovePercent: 0.5,
				hasEarningsNearby: true,
			}),
		).toBe(
			"The broader market (SPY) moved up 0.50% today. Earnings are expected within the next couple of days.",
		);
	});

	it("renders an empty string when there is nothing to say", () => {
		expect(
			renderSignalSentence({
				benchmarkLabel: "broader market (SPY)",
				benchmarkMovePercent: null,
				hasEarningsNearby: false,
			}),
		).toBe("");
	});
});
