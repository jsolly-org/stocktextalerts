import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";
import type { TickerDetail } from "../types";
import { MASSIVE_TICKERS_PATH_PREFIX } from "./constants";

/** Fetch enrichment detail for a single ticker: icon URL. */
export async function fetchTickerDetail(symbol: string): Promise<TickerDetail> {
	const data = await marketDataFetch(
		`${MASSIVE_TICKERS_PATH_PREFIX}/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
		{ symbol },
	);

	if (!isRecord(data)) {
		return { ok: false, iconUrl: null };
	}

	const results = data.results;
	if (!isRecord(results)) {
		return { ok: false, iconUrl: null };
	}

	const branding = results.branding;

	let iconUrl: string | null = null;
	if (isRecord(branding)) {
		const url = branding.icon_url;
		if (typeof url === "string" && url.trim() !== "") {
			iconUrl = url;
		}
	}

	return { ok: true, iconUrl };
}
