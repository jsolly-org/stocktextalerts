import { marketDataFetch } from "../../vendors/massive";
import { sicCodeToSector } from "../sector-mapping";

const MASSIVE_TICKERS_PATH_PREFIX = "/v3/reference/tickers";

/** Fetch enrichment detail for a single ticker: icon URL and sector. */
export async function fetchTickerDetail(
	symbol: string,
): Promise<{ ok: boolean; iconUrl: string | null; sector: string | null }> {
	const data = await marketDataFetch(
		`${MASSIVE_TICKERS_PATH_PREFIX}/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
		{ symbol },
	);

	if (typeof data !== "object" || data === null) {
		return { ok: false, iconUrl: null, sector: null };
	}

	const results = (data as Record<string, unknown>).results;
	if (typeof results !== "object" || results === null) {
		return { ok: false, iconUrl: null, sector: null };
	}

	const rec = results as Record<string, unknown>;
	const sicCode = rec.sic_code;
	const branding = rec.branding;

	let iconUrl: string | null = null;
	if (typeof branding === "object" && branding !== null) {
		const url = (branding as Record<string, unknown>).icon_url;
		if (typeof url === "string" && url.trim() !== "") {
			iconUrl = url;
		}
	}

	let sector: string | null = null;
	if (typeof sicCode === "string" || typeof sicCode === "number") {
		sector = sicCodeToSector(String(sicCode));
	}

	return { ok: true, iconUrl, sector };
}
