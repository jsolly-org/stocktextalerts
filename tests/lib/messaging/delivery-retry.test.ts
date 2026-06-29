import { describe, expect, it, vi } from "vitest";
import { withDeliveryRetry } from "../../../src/lib/messaging/delivery-retry";
import type { DeliveryResult } from "../../../src/lib/types";
import { expectConsoleError } from "../../setup";

const noSleep = () => Promise.resolve();

describe("withDeliveryRetry", () => {
	it("A transient SES throttle succeeds on the second attempt", async () => {
		const results: DeliveryResult[] = [
			{ success: false, error: "throttled", errorCode: "ThrottlingException" },
			{ success: true, messageSid: "ses-msg-1" },
		];
		const send = vi.fn(async () => results.shift() as DeliveryResult);

		const result = await withDeliveryRetry(send, { channel: "email", sleep: noSleep });

		expect(result).toEqual({ success: true, messageSid: "ses-msg-1" });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("A permanent 400 is not retried", async () => {
		expectConsoleError("Delivery failed");
		const send = vi.fn(
			async (): Promise<DeliveryResult> => ({
				success: false,
				error: "bad recipient",
				errorCode: "InvalidParameterValue",
			}),
		);

		const result = await withDeliveryRetry(send, { channel: "email", sleep: noSleep });

		expect(result.success).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("A vendor down for the whole window exhausts maxAttempts and returns the last failure", async () => {
		expectConsoleError("Delivery failed");
		const send = vi.fn(
			async (): Promise<DeliveryResult> => ({
				success: false,
				error: "service unavailable",
				errorCode: "503",
			}),
		);

		const result = await withDeliveryRetry(send, {
			channel: "sms",
			maxAttempts: 3,
			sleep: noSleep,
		});

		expect(result.success).toBe(false);
		expect(send).toHaveBeenCalledTimes(3);
	});
});
