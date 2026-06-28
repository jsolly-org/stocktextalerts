import { describe, expect, it } from "vitest";
import { buildEmailUrls, renderEmailFooter } from "../../../src/lib/messaging/email/layout";
import {
	NOT_FINANCIAL_ADVICE,
	SMS_OPT_OUT,
	TELEGRAM_FOOTER,
} from "../../../src/lib/messaging/parts/footer";

describe("Every channel's footer carries the disclaimer AND an opt-out path (fmt-4 contract)", () => {
	it("The Telegram footer has both the disclaimer and the /stop opt-out hint", () => {
		// Telegram historically had the disclaimer but no opt-out; the contract adds one.
		expect(TELEGRAM_FOOTER).toContain(NOT_FINANCIAL_ADVICE);
		expect(TELEGRAM_FOOTER).toContain("/stop");
	});

	it("The shared email footer carries the disclaimer alongside the unsubscribe link", () => {
		// Email historically had the opt-out but no disclaimer; the contract adds one.
		const urls = buildEmailUrls(
			"00000000-0000-0000-0000-000000000001",
			"sarah.chen@example.com",
			"marketNotifications",
		);
		const html = renderEmailFooter(urls);
		expect(html).toContain(NOT_FINANCIAL_ADVICE);
		expect(html).toContain("Unsubscribe from all emails");
	});

	it("The SMS opt-out line is the canonical STOP wording", () => {
		expect(SMS_OPT_OUT).toBe("Reply STOP to opt out.");
	});
});
