import { describe, expect, it } from "vitest";
import { buildEmailUrls, renderEmailFooter } from "../../../../src/lib/messaging/email/layout";
import { SMS_OPT_OUT, TELEGRAM_FOOTER } from "../../../../src/lib/messaging/parts/footer";

describe("Personal-app notification footers: opt-out paths only, no disclaimer", () => {
	it("The Telegram footer is just the actionable /stop hint — no disclaimer", () => {
		expect(TELEGRAM_FOOTER).toContain("/stop");
		expect(TELEGRAM_FOOTER.toLowerCase()).not.toContain("financial advice");
	});

	it("The shared email footer keeps the unsubscribe link and drops the disclaimer", () => {
		const urls = buildEmailUrls(
			"00000000-0000-0000-0000-000000000001",
			"sarah.chen@example.com",
			"marketNotifications",
		);
		const html = renderEmailFooter(urls);
		expect(html).toContain("Unsubscribe from all emails");
		expect(html.toLowerCase()).not.toContain("financial advice");
	});

	it("The SMS opt-out line is the canonical STOP wording (carrier A2P requirement).", () => {
		expect(SMS_OPT_OUT).toBe("Reply STOP to opt out.");
	});
});
