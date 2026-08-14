import { describe, expect, it } from "vitest";
import {
	buildPreviewEmailRows,
	buildPreviewTelegramLines,
	DEMO_ASSETS,
	PREVIEW_EMAIL_SUBJECT,
} from "../../../../src/components/dashboard/notification-channels/preview/preview-data";

describe("notification preview data", () => {
	it("keeps the scheduled-price email subject in sync with formatMarketScheduledEmail", () => {
		expect(PREVIEW_EMAIL_SUBJECT).toBe("Scheduled Price Update");
	});

	it("builds email rows with production price, change-%, and sparkline helpers", () => {
		const rows = buildPreviewEmailRows(DEMO_ASSETS);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			symbol: "AAPL",
			price: "$195.50",
			change: "(+3.72%)",
			changeColor: "#166534",
			sparklineLabel: "Past 7 trading days",
		});
		expect(rows[0]?.sparklineSrc).toMatch(/^data:image\/svg\+xml;base64,/);
		expect(rows[2]).toMatchObject({
			symbol: "TSLA",
			price: "$248.30",
			change: "(-2.75%)",
			changeColor: "#b91c1c",
		});
	});

	it("builds Telegram price-update lines with direction dots", () => {
		const lines = buildPreviewTelegramLines(DEMO_ASSETS);
		expect(lines[0]).toMatchObject({
			symbol: "AAPL",
			price: "$195.50",
			change: "+3.72%",
		});
		expect(lines[0]?.dot).toBeTruthy();
		expect(lines[2]).toMatchObject({
			symbol: "TSLA",
			change: "-2.75%",
		});
	});
});
