import { afterEach, describe, expect, it, vi } from "vitest";
import {
	directionFromTriggerPercent,
	wakeupAssetBuyerFromFlatAlert,
} from "../../../../src/lib/market-notifications/flat-alerts/asset-buyer-wakeup";

describe("directionFromTriggerPercent", () => {
	it("maps positive / negative / zero", () => {
		expect(directionFromTriggerPercent(5.2)).toBe("up");
		expect(directionFromTriggerPercent(-3.1)).toBe("down");
		expect(directionFromTriggerPercent(0)).toBe("flat");
	});
});

describe("wakeupAssetBuyerFromFlatAlert", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("no-ops with warn path when ARN is missing", async () => {
		const invoke = vi.fn();
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "NVDA",
			triggerPercent: 5.5,
			isAcceleration: false,
			resolveArn: async () => undefined,
			invoke,
		});
		expect(ok).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("async-invokes with the expected payload shape", async () => {
		const invoke = vi.fn(async () => {});
		const asOf = "2026-08-08T20:00:00.000Z";
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "nvda",
			triggerPercent: -6.25,
			isAcceleration: true,
			asOf,
			resolveArn: async () => "arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			invoke,
		});
		expect(ok).toBe(true);
		expect(invoke).toHaveBeenCalledOnce();
		expect(invoke).toHaveBeenCalledWith(
			"arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			{
				source: "sta_flat_price_alert",
				prioritizeTicker: "NVDA",
				ticker: "NVDA",
				direction: "down",
				triggerPercent: -6.25,
				isAcceleration: true,
				asOf,
			},
		);
	});

	it("fail-opens when invoke throws", async () => {
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "MSFT",
			triggerPercent: 5,
			isAcceleration: false,
			resolveArn: async () => "arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			invoke: async () => {
				throw new Error("boom");
			},
		});
		expect(ok).toBe(false);
	});
});
