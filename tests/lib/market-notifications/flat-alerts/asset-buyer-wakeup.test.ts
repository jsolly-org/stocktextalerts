import { afterEach, describe, expect, it, vi } from "vitest";
import {
	directionFromTriggerPercent,
	wakeupAssetBuyerFromDailyDigest,
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
			quote: { price: 120, prevClose: 114, changePercent: 5.5 },
			session: "pre",
			resolveArn: async () => undefined,
			invoke,
		});
		expect(ok).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("async-invokes with the expected payload shape", async () => {
		const invoke = vi.fn(async () => {});
		const asOf = "2026-08-08T20:00:00.000Z";
		const quote = { price: 118, prevClose: 126, dayOpen: 124, changePercent: -6.25 };
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "nvda",
			triggerPercent: -6.25,
			isAcceleration: true,
			asOf,
			quote,
			session: "after",
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
				quote,
				session: "after",
			},
		);
	});

	it("includes catalystPacket on the payload when provided", async () => {
		const invoke = vi.fn(async () => {});
		const packet = { lede: "Earnings beat", grade: "confirmed", claims: [] };
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "AAPL",
			triggerPercent: 5.1,
			isAcceleration: false,
			asOf: "2026-08-12T15:00:00.000Z",
			quote: { price: 195, prevClose: 185, dayOpen: 186, changePercent: 5.1 },
			session: "regular",
			catalystPacket: packet,
			resolveArn: async () => "arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			invoke,
		});
		expect(ok).toBe(true);
		expect(invoke).toHaveBeenCalledWith(
			"arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			expect.objectContaining({
				ticker: "AAPL",
				catalystPacket: packet,
			}),
		);
	});

	it("fail-opens when invoke throws", async () => {
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "MSFT",
			triggerPercent: 5,
			isAcceleration: false,
			quote: { price: 420, prevClose: 400, changePercent: 5 },
			session: "regular",
			resolveArn: async () => "arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			invoke: async () => {
				throw new Error("boom");
			},
		});
		expect(ok).toBe(false);
	});
});

describe("wakeupAssetBuyerFromDailyDigest", () => {
	it("async-invokes with source sta_daily_digest and no ticker", async () => {
		const invoke = vi.fn(async () => {});
		const ok = await wakeupAssetBuyerFromDailyDigest({
			resolveArn: async () => "arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			invoke,
		});
		expect(ok).toBe(true);
		expect(invoke).toHaveBeenCalledOnce();
		expect(invoke).toHaveBeenCalledWith(
			"arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			{ source: "sta_daily_digest" },
		);
	});

	it("fail-opens when invoke throws", async () => {
		const ok = await wakeupAssetBuyerFromDailyDigest({
			resolveArn: async () => "arn:aws:lambda:us-east-1:123:function:asset-buyer-heartbeat",
			invoke: async () => {
				throw new Error("boom");
			},
		});
		expect(ok).toBe(false);
	});
});
