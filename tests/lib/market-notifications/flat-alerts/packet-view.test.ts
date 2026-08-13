import { describe, expect, it } from "vitest";
import {
	formatClaimPublishTime,
	formatReportAsOf,
	parsePriceMoveReportView,
	renderLedeHtml,
} from "../../../../src/lib/market-notifications/flat-alerts/packet-view";

describe("parsePriceMoveReportView", () => {
	it("returns a view without grade and with safe claim URLs", () => {
		const view = parsePriceMoveReportView({
			lede: "Shares jumped after guidance [Reuters](https://www.reuters.com/example).",
			grade: "confirmed",
			move_onset: "09:41 ET",
			key_entity: "Acme Corp",
			claims: [
				{
					text: "Company raised full-year outlook.",
					source_url: "https://www.reuters.com/example",
					publish_time: "2026-08-13T14:02:00Z",
				},
				{
					text: "Should not render this link.",
					source_url: "javascript:alert(1)",
					publish_time: "",
				},
			],
		});

		expect(view).not.toBeNull();
		expect(view).not.toHaveProperty("grade");
		expect(JSON.stringify(view)).not.toContain("confirmed");
		expect(view?.lede).toContain("Shares jumped");
		expect(view?.moveOnset).toBe("09:41 ET");
		expect(view?.keyEntity).toBe("Acme Corp");
		expect(view?.claims).toHaveLength(2);
		expect(view?.claims[0]?.sourceUrl).toBe("https://www.reuters.com/example");
		expect(view?.claims[0]?.sourceHost).toBe("reuters.com");
		expect(view?.claims[1]?.sourceUrl).toBeNull();
		expect(view?.ledeHtml).toContain('href="https://www.reuters.com/example"');
		expect(view?.ledeHtml).toContain(">Reuters</a>");
	});

	it("returns null for empty or missing lede", () => {
		expect(parsePriceMoveReportView(null)).toBeNull();
		expect(parsePriceMoveReportView({ lede: "   " })).toBeNull();
		expect(parsePriceMoveReportView({ grade: "confirmed" })).toBeNull();
	});
});

describe("renderLedeHtml", () => {
	it("escapes HTML outside markdown links", () => {
		const html = renderLedeHtml("Up <script>alert(1)</script> [Safe](https://example.com/a)");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain('href="https://example.com/a"');
	});
});

describe("formatReportAsOf", () => {
	it("formats in the user's timezone", () => {
		const label = formatReportAsOf("2026-08-13T18:30:00.000Z", "America/New_York", false);
		expect(label).toMatch(/2026/);
		expect(label).toMatch(/EDT|EST/);
	});
});

describe("formatClaimPublishTime", () => {
	it("formats ISO timestamps and leaves other strings alone", () => {
		expect(formatClaimPublishTime("not-a-date", "America/New_York", false)).toBe("not-a-date");
		expect(formatClaimPublishTime("2026-08-13T13:15:00Z", "America/New_York", false)).toMatch(
			/2026/,
		);
	});
});
