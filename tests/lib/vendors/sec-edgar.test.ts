import { describe, expect, it } from "vitest";
import {
	formatFilingsSectionMarkdown,
	formatFilingsSectionPlainText,
} from "../../../src/lib/asset-events/format";
import {
	buildEdgarFilingUrl,
	cikWithoutLeadingZeros,
	isMaterialCurrentReportForm,
	padCik,
	resolveSecCikFromTickerMap,
} from "../../../src/lib/vendors/sec-edgar";

describe("sec-edgar helpers", () => {
	it("pads CIKs to 10 digits", () => {
		expect(padCik(320193)).toBe("0000320193");
		expect(padCik("320193")).toBe("0000320193");
		expect(padCik("0000320193")).toBe("0000320193");
	});

	it("strips leading zeros for Archives paths", () => {
		expect(cikWithoutLeadingZeros("0000320193")).toBe("320193");
		expect(cikWithoutLeadingZeros("0")).toBe("0");
	});

	it("filters material current-report forms", () => {
		expect(isMaterialCurrentReportForm("8-K")).toBe(true);
		expect(isMaterialCurrentReportForm("8-K/A")).toBe(true);
		expect(isMaterialCurrentReportForm("6-K")).toBe(true);
		expect(isMaterialCurrentReportForm("6-K/A")).toBe(true);
		expect(isMaterialCurrentReportForm("10-K")).toBe(false);
		expect(isMaterialCurrentReportForm("4")).toBe(false);
		expect(isMaterialCurrentReportForm("S-8")).toBe(false);
	});

	it("builds EDGAR document URLs", () => {
		expect(
			buildEdgarFilingUrl({
				cik: "0000320193",
				accessionNumber: "0000320193-24-000123",
				primaryDocument: "aapl-20240724.htm",
			}),
		).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240724.htm");
		expect(
			buildEdgarFilingUrl({
				cik: "0000320193",
				accessionNumber: "0000320193-24-000123",
				primaryDocument: null,
			}),
		).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/");
	});

	it("falls back to the index URL when primaryDocument is unsafe", () => {
		expect(
			buildEdgarFilingUrl({
				cik: "0000320193",
				accessionNumber: "0000320193-24-000123",
				primaryDocument: "evil)[x](https://evil.example",
			}),
		).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/");
	});

	it("resolves SEC CIKs for Massive dotted share-class tickers", () => {
		const map = new Map([["BRK-B", "0001067983"]]);
		expect(resolveSecCikFromTickerMap(map, "BRK.B")).toBe("0001067983");
		expect(resolveSecCikFromTickerMap(map, "BRK-B")).toBe("0001067983");
		expect(resolveSecCikFromTickerMap(map, "AAPL")).toBeUndefined();
	});
});

describe("filings formatters", () => {
	const lines = [
		{
			label: "AAPL 8-K · Jul 24",
			url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl.htm",
		},
	];

	it("formats plain text with the URL on the next line", () => {
		expect(formatFilingsSectionPlainText(lines)).toBe(
			"AAPL 8-K · Jul 24\nhttps://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl.htm",
		);
	});

	it("formats markdown with the whole label as the link text", () => {
		expect(formatFilingsSectionMarkdown(lines)).toBe(
			"[AAPL 8-K · Jul 24](https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl.htm)",
		);
	});
});
