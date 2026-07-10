/**
 * Fetch-level tests for Massive ticker detail plus unit tests for the logo URL
 * SSRF/write-time allowlist.
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
	fetchTickerDetail,
	isAllowedLogoUrl,
} from "../../../../src/lib/assets/reference/ticker-detail";
import { VENDOR_FETCH_MAX_RETRIES } from "../../../../src/lib/vendors/constants";
import { expectConsoleError } from "../../../setup";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const MASSIVE_AAPL_LOGO_URL =
	"https://api.massive.com/v1/reference/company-branding/d3d3LmFwcGxlLmNvbQ/images/2026-04-01_icon.png";
const FINNHUB_AAPL_LOGO_URL =
	"https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AAPL.png";

function detailResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("fetchTickerDetail", () => {
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("returns Massive's branding icon as a definitive answer", async () => {
		fetchSpy.mockResolvedValue(
			detailResponse({
				results: {
					ticker: "AAPL",
					name: "Apple Inc.",
					branding: { icon_url: MASSIVE_AAPL_LOGO_URL },
				},
			}),
		);

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({
			ok: true,
			iconUrl: MASSIVE_AAPL_LOGO_URL,
		});
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://api.massive.com/v3/reference/tickers/AAPL?apiKey=test-massive-key",
		);
	});

	it("treats results with no branding icon as a definitive no-logo answer", async () => {
		fetchSpy.mockResolvedValue(
			detailResponse({ results: { ticker: "SACH", name: "Sachem Capital Corp" } }),
		);

		await expect(fetchTickerDetail("SACH")).resolves.toEqual({ ok: true, iconUrl: null });
	});

	it("treats an empty branding icon as a definitive no-logo answer", async () => {
		fetchSpy.mockResolvedValue(
			detailResponse({
				results: { ticker: "SACH", branding: { icon_url: "   " } },
			}),
		);

		await expect(fetchTickerDetail("SACH")).resolves.toEqual({ ok: true, iconUrl: null });
	});

	it("returns transient failure when the results shape is missing", async () => {
		fetchSpy.mockResolvedValue(detailResponse({ status: "OK" }));

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({ ok: false });
	});

	it("returns transient failure after transport retries are exhausted", async () => {
		expectConsoleError(/exhausted retries/);
		fetchSpy.mockResolvedValue(detailResponse({ status: "ERROR" }, 500));

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({ ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(VENDOR_FETCH_MAX_RETRIES);
	});

	it("returns transient failure after request timeouts are exhausted", async () => {
		expectConsoleError(/exhausted retries/);
		fetchSpy.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({ ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(VENDOR_FETCH_MAX_RETRIES);
	});
});

describe("isAllowedLogoUrl", () => {
	it("accepts https URLs on the Massive and legacy Finnhub CDN hosts", () => {
		expect(isAllowedLogoUrl(MASSIVE_AAPL_LOGO_URL)).toBe(true);
		expect(isAllowedLogoUrl("https://static.finnhub.io/logo/8ed99cb0-80ec-11ea.png")).toBe(true);
		expect(isAllowedLogoUrl(FINNHUB_AAPL_LOGO_URL)).toBe(true);
	});

	it("rejects plain http, even on an allowed host", () => {
		expect(isAllowedLogoUrl("http://api.massive.com/logo/AAPL.png")).toBe(false);
	});

	it("rejects an explicit port, even on an allowed host", () => {
		expect(isAllowedLogoUrl("https://api.massive.com:8443/logo/AAPL.png")).toBe(false);
	});

	it("rejects unknown hosts", () => {
		expect(isAllowedLogoUrl("https://logo.clearbit.com/apple.com")).toBe(false);
		expect(isAllowedLogoUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
	});

	it("rejects values that are not URLs", () => {
		expect(isAllowedLogoUrl("AAPL logo (see attachment)")).toBe(false);
	});
});
