import { describe, expect, it } from "vitest";
import { parsePriceMoveWhyMessage } from "../../../../src/lib/market-notifications/flat-alerts/why-queue";

function whyBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		kind: "price-move-why",
		userId: "00000000-0000-0000-0000-000000000001",
		symbol: "MOD",
		companyName: "Modine",
		quote: { price: 107.76, prevClose: 100, dayOpen: 101, changePercent: 7.76 },
		baseline: 100,
		triggerPercent: 7.76,
		thresholdValue: 5,
		sessionPercent: 7.76,
		isReTrigger: false,
		isAcceleration: false,
		lastNotificationAt: null,
		iconUrl: null,
		session: "pre",
		...overrides,
	});
}

describe("parsePriceMoveWhyMessage session", () => {
	it("keeps an equity trade session from the SQS body", () => {
		const parsed = parsePriceMoveWhyMessage(whyBody());
		expect(parsed?.session).toBe("pre");
		expect(parsed?.quote.price).toBe(107.76);
	});

	it("omits closed or garbage session values", () => {
		expect(parsePriceMoveWhyMessage(whyBody({ session: "closed" }))?.session).toBeUndefined();
		expect(parsePriceMoveWhyMessage(whyBody({ session: "nope" }))?.session).toBeUndefined();
		expect(parsePriceMoveWhyMessage(whyBody({ session: undefined }))?.session).toBeUndefined();
	});
});
