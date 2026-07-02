import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";
import { sicCodeToSector } from "../sector-mapping";
import type { TickerDetail } from "../types";
import { MASSIVE_TICKERS_PATH_PREFIX } from "./constants";

/** Fetch enrichment detail for a single ticker: icon URL and sector. */
export async function fetchTickerDetail(symbol: string): Promise<TickerDetail> {
	const data = await marketDataFetch(
		`${MASSIVE_TICKERS_PATH_PREFIX}/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
		{ symbol },
	);

	if (!isRecord(data)) {
		return { ok: false, iconUrl: null, sector: null };
	}

	const results = data.results;
	if (!isRecord(results)) {
		return { ok: false, iconUrl: null, sector: null };
	}

	const sicCode = results.sic_code;
	const branding = results.branding;

	let iconUrl: string | null = null;
	if (isRecord(branding)) {
		const url = branding.icon_url;
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
