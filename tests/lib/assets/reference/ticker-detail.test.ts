/**
 * Fetch-level tests for `fetchTickerDetail` (stubbed `globalThis.fetch`, no vi.mock)
 * plus unit tests for the `isAllowedLogoUrl` SSRF/write-time gate.
 *
 * The TickerDetail union is the contract under test: `ok: true` is a DEFINITIVE
 * answer (the backfill stamps `icon_checked_at` permanently), `ok: false` is
 * transient (row retries later) — so the shape-drift and transport cases must
 * come back `ok: false`, never definitive-none.
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
	fetchTickerDetail,
	isAllowedLogoUrl,
} from "../../../../src/lib/assets/reference/ticker-detail";
import { VENDOR_FETCH_MAX_RETRIES } from "../../../../src/lib/vendors/constants";

// Mock retry delays so transport-failure tests don't wait real seconds.
vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const AAPL_LOGO_URL =
	"https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AAPL.png";

/** A realistic Finnhub /stock/profile2 body for AAPL. */
function appleProfile(): Record<string, unknown> {
	return {
		country: "US",
		currency: "USD",
		exchange: "NASDAQ NMS - GLOBAL MARKET",
		finnhubIndustry: "Technology",
		ipo: "1980-12-12",
		logo: AAPL_LOGO_URL,
		marketCapitalization: 3286752.4,
		name: "Apple Inc",
		phone: "14089961010",
		shareOutstanding: 15207.98,
		ticker: "AAPL",
		weburl: "https://www.apple.com/",
	};
}

function profileResponse(body: unknown, status = 200): Response {
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

	it("A live company profile with a logo is a definitive answer carrying the icon URL", async () => {
		fetchSpy.mockResolvedValue(profileResponse(appleProfile()));

		const detail = await fetchTickerDetail("AAPL");

		const fetchedUrl = String(fetchSpy.mock.calls[0]?.[0]);
		expect(fetchedUrl).toBe(
			"https://finnhub.io/api/v1/stock/profile2?symbol=AAPL&token=test-finnhub-key",
		);
		expect(detail).toEqual({ ok: true, iconUrl: AAPL_LOGO_URL });
	});

	it("An unknown symbol (empty {} body) is a definitive 'no logo' answer", async () => {
		fetchSpy.mockResolvedValue(profileResponse({}));

		await expect(fetchTickerDetail("ZZZZDELISTD")).resolves.toEqual({
			ok: true,
			iconUrl: null,
		});
	});

	it("A full profile whose logo field is empty is a definitive 'no logo' answer", async () => {
		fetchSpy.mockResolvedValue(
			profileResponse({
				...appleProfile(),
				logo: "",
				name: "Sachem Capital Corp",
				ticker: "SACH",
			}),
		);

		await expect(fetchTickerDetail("SACH")).resolves.toEqual({ ok: true, iconUrl: null });
	});

	it("A non-empty profile missing the logo key entirely is shape drift — NOT a definitive none", async () => {
		// If Finnhub renamed the field, treating this as "no logo" would durably
		// stamp checked-no-icon across the whole nightly drip.
		fetchSpy.mockResolvedValue(profileResponse({ name: "Apple Inc", ticker: "AAPL" }));

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({ ok: false });
	});

	it("An HTTP 500 across all retries is a transient transport failure, left for a later run", async () => {
		fetchSpy.mockImplementation(async () =>
			profileResponse({ error: "Internal server error" }, 500),
		);

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({ ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(VENDOR_FETCH_MAX_RETRIES);
	});

	it("A request timeout across all retries is a transient transport failure", async () => {
		fetchSpy.mockImplementation(async () => {
			const timeout = new Error("The operation was aborted due to timeout");
			timeout.name = "TimeoutError";
			throw timeout;
		});

		await expect(fetchTickerDetail("AAPL")).resolves.toEqual({ ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(VENDOR_FETCH_MAX_RETRIES);
	});
});

describe("isAllowedLogoUrl", () => {
	it("accepts https URLs on the Massive and Finnhub CDN hosts", () => {
		expect(
			isAllowedLogoUrl("https://api.massive.com/v1/reference/tickers/AAPL/branding/logo.png"),
		).toBe(true);
		expect(isAllowedLogoUrl("https://static.finnhub.io/logo/8ed99cb0-80ec-11ea.png")).toBe(true);
		expect(isAllowedLogoUrl(AAPL_LOGO_URL)).toBe(true);
	});

	it("rejects plain http, even on an allowed host", () => {
		expect(isAllowedLogoUrl("http://static.finnhub.io/logo/AAPL.png")).toBe(false);
	});

	it("rejects an explicit port, even on an allowed host", () => {
		expect(isAllowedLogoUrl("https://static.finnhub.io:8443/logo/AAPL.png")).toBe(false);
	});

	it("rejects unknown hosts (the SSRF case for a poisoned icon_url)", () => {
		expect(isAllowedLogoUrl("https://logo.clearbit.com/apple.com")).toBe(false);
		expect(isAllowedLogoUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
	});

	it("rejects garbage that is not a URL at all", () => {
		expect(isAllowedLogoUrl("AAPL logo (see attachment)")).toBe(false);
	});
});
