import { rootLogger } from "../../logging";
import { isRecord } from "../../types";
import { finnhubFetch } from "../../vendors/finnhub";
import type { ActiveTicker, ActiveUniverse } from "../types";
import { FINNHUB_SECURITY_TYPES } from "./constants";

/**
 * Fetch the complete active US listing from Finnhub's `/stock/symbol` (free tier,
 * one call) and split it into:
 *
 * - `tickers` — the de-duplicated stock/etf subset we list in `assets`
 *   (Common Stock / ADR / REIT / ETP; dotted share-class symbols excluded, matching
 *   the historical universe shape), and
 * - `allActiveSymbols` — EVERY active symbol Finnhub returned, regardless of
 *   security type. Delist-absence decisions key on this superset so a security-type
 *   classification quirk can never read as "vanished from the market".
 *
 * A transport failure (finnhubFetch returns null) or an unexpected payload yields an
 * empty universe — the reconcile's empty-set abort treats that as provider failure
 * before any mutation.
 *
 * NOTE: Finnhub `description` values are upper-case. They are stored as-is for NEW
 * listings only — reconcile never rewrites the name of an existing row, so the
 * Massive-era proper-case names are preserved.
 */
export async function fetchActiveTickers(): Promise<ActiveUniverse> {
	const empty: ActiveUniverse = { tickers: [], allActiveSymbols: new Set() };

	const data = await finnhubFetch("/stock/symbol", { exchange: "US" }, "stock-symbols");
	if (!Array.isArray(data)) {
		if (data !== null) {
			rootLogger.error("Finnhub stock-symbols payload was not an array", {
				action: "fetch_active_tickers",
			});
		}
		return empty;
	}

	const allActiveSymbols = new Set<string>();
	const seen = new Set<string>();
	const tickers: ActiveTicker[] = [];
	for (const item of data) {
		if (!isRecord(item)) continue;
		const symbol = typeof item.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
		if (!symbol) continue;
		allActiveSymbols.add(symbol);

		const name = typeof item.description === "string" ? item.description.trim() : "";
		const normalizedType =
			typeof item.type === "string" ? FINNHUB_SECURITY_TYPES.get(item.type) : undefined;
		if (!name || !normalizedType || symbol.includes(".") || seen.has(symbol)) continue;
		// Match the DB constraints (symbol varchar(10) + no-whitespace CHECK, name
		// varchar(255)): one malformed vendor row must not fail its whole 500-row
		// insert chunk — and recur every week — over a constraint violation.
		if (symbol.length > 10 || /\s/.test(symbol)) continue;
		seen.add(symbol);
		tickers.push({ symbol, name: name.slice(0, 255), type: normalizedType });
	}

	rootLogger.info("Finnhub active universe fetched", {
		action: "fetch_active_tickers",
		totalSymbols: allActiveSymbols.size,
		listedTickers: tickers.length,
	});
	return { tickers, allActiveSymbols };
}
