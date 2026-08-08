import { describe, expect, it } from "vitest";
import {
	effectivePriceMoveThreshold,
	priceMoveDirection,
} from "../../../../src/lib/market-notifications/flat-alerts/threshold";

describe("priceMoveDirection", () => {
	it("returns 1 / -1 / 0 for up, down, and flat", () => {
		expect(priceMoveDirection(105, 100)).toBe(1);
		expect(priceMoveDirection(95, 100)).toBe(-1);
		expect(priceMoveDirection(100, 100)).toBe(0);
	});
});

describe("effectivePriceMoveThreshold", () => {
	it("uses the full threshold for first-of-day alerts", () => {
		expect(
			effectivePriceMoveThreshold({
				configuredValue: 5,
				isReTrigger: false,
				lastAlertDirection: 1,
				moveDirection: 1,
			}),
		).toEqual({ value: 5, isAcceleration: false });
	});

	it("uses half the threshold for same-direction re-triggers", () => {
		expect(
			effectivePriceMoveThreshold({
				configuredValue: 5,
				isReTrigger: true,
				lastAlertDirection: 1,
				moveDirection: 1,
			}),
		).toEqual({ value: 2.5, isAcceleration: true });
		expect(
			effectivePriceMoveThreshold({
				configuredValue: 4,
				isReTrigger: true,
				lastAlertDirection: -1,
				moveDirection: -1,
			}),
		).toEqual({ value: 2, isAcceleration: true });
	});

	it("keeps the full threshold for reverse (recovery) moves", () => {
		expect(
			effectivePriceMoveThreshold({
				configuredValue: 5,
				isReTrigger: true,
				lastAlertDirection: 1,
				moveDirection: -1,
			}),
		).toEqual({ value: 5, isAcceleration: false });
	});

	it("keeps the full threshold when last direction is unknown (legacy rows)", () => {
		expect(
			effectivePriceMoveThreshold({
				configuredValue: 5,
				isReTrigger: true,
				lastAlertDirection: null,
				moveDirection: 1,
			}),
		).toEqual({ value: 5, isAcceleration: false });
	});
});
