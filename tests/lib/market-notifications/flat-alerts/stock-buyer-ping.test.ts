/**
 * Contract tests: STA stock-buyer (delivery_channel=lambda) pings asset-buyer.
 * Covers the AWS Invoke path payload shape asset-buyer heartbeat expects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lambdaSend = vi.hoisted(() => vi.fn(async () => ({})));
const ssmSend = vi.hoisted(() =>
	vi.fn(async () => ({
		Parameter: { Value: "arn:aws:lambda:us-east-1:1:function:from-ssm" },
	})),
);

vi.mock("@aws-sdk/client-lambda", () => ({
	LambdaClient: class {
		send = lambdaSend;
	},
	InvokeCommand: class {
		input: Record<string, unknown>;
		constructor(input: Record<string, unknown>) {
			this.input = input;
		}
	},
}));

vi.mock("@aws-sdk/client-ssm", () => ({
	SSMClient: class {
		send = ssmSend;
	},
	GetParameterCommand: class {
		input: Record<string, unknown>;
		constructor(input: Record<string, unknown>) {
			this.input = input;
		}
	},
}));

import { STOCK_BUYER_TICKERS } from "../../../../scripts/provision-stock-buyer-user";
import { wakeupAssetBuyerFromFlatAlert } from "../../../../src/lib/market-notifications/flat-alerts/asset-buyer-wakeup";

describe("stock-buyer → asset-buyer Lambda ping", () => {
	beforeEach(() => {
		lambdaSend.mockClear();
		ssmSend.mockClear();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("sends an async Event invoke with prioritizeTicker for a down move", async () => {
		vi.stubEnv(
			"ASSET_BUYER_HEARTBEAT_ARN",
			"arn:aws:lambda:us-east-1:123456789012:function:asset-buyer-heartbeat",
		);

		const asOf = "2026-08-08T16:30:00.000Z";
		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "TSLA",
			triggerPercent: -5.4,
			isAcceleration: false,
			asOf,
		});

		expect(ok).toBe(true);
		expect(lambdaSend).toHaveBeenCalledOnce();
		const call = lambdaSend.mock.calls[0] as unknown as
			| [{ input: Record<string, unknown> }]
			| undefined;
		expect(call).toBeDefined();
		if (call === undefined) {
			throw new Error("expected Lambda InvokeCommand");
		}
		const [command] = call;
		expect(command.input.FunctionName).toBe(
			"arn:aws:lambda:us-east-1:123456789012:function:asset-buyer-heartbeat",
		);
		expect(command.input.InvocationType).toBe("Event");

		const raw = command.input.Payload;
		expect(raw).toBeInstanceOf(Buffer);
		const payload = JSON.parse((raw as Buffer).toString("utf8")) as Record<string, unknown>;
		// Matches asset-buyer HeartbeatEvent + STA metadata.
		expect(payload).toEqual({
			source: "sta_flat_price_alert",
			prioritizeTicker: "TSLA",
			ticker: "TSLA",
			direction: "down",
			triggerPercent: -5.4,
			isAcceleration: false,
			asOf,
		});
	});

	it("falls back to SSM /asset-buyer/heartbeat-arn when env is unset", async () => {
		vi.stubEnv("ASSET_BUYER_HEARTBEAT_ARN", "");

		const ok = await wakeupAssetBuyerFromFlatAlert({
			symbol: "NVDA",
			triggerPercent: 5.1,
			isAcceleration: true,
		});

		expect(ok).toBe(true);
		expect(ssmSend).toHaveBeenCalledOnce();
		expect(lambdaSend).toHaveBeenCalledOnce();
		const call = lambdaSend.mock.calls[0] as unknown as
			| [{ input: Record<string, unknown> }]
			| undefined;
		expect(call).toBeDefined();
		if (call === undefined) {
			throw new Error("expected Lambda InvokeCommand");
		}
		const [command] = call;
		expect(command.input.FunctionName).toBe("arn:aws:lambda:us-east-1:1:function:from-ssm");
		const payload = JSON.parse((command.input.Payload as Buffer).toString("utf8")) as Record<
			string,
			unknown
		>;
		expect(payload.direction).toBe("up");
		expect(payload.isAcceleration).toBe(true);
		expect(payload.prioritizeTicker).toBe("NVDA");
	});

	it("provision watchlist stays within the 50-asset cap and matches buyer universe size", () => {
		expect(STOCK_BUYER_TICKERS.length).toBe(40);
		expect(STOCK_BUYER_TICKERS.length).toBeLessThanOrEqual(50);
		expect(new Set(STOCK_BUYER_TICKERS).size).toBe(STOCK_BUYER_TICKERS.length);
		expect(STOCK_BUYER_TICKERS).toContain("TSLA");
		expect(STOCK_BUYER_TICKERS).toContain("RBRK");
	});
});
