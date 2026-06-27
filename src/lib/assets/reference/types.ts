/** Authoritative delisting record for a single symbol. */
export interface TickerReferenceResult {
	symbol: string;
	active: false;
	delistedUtc: string;
	primaryExchange: string | null;
	name: string | null;
}

export type TickerReferenceStatus =
	| { status: "delisted"; result: TickerReferenceResult }
	| { status: "unknown"; symbol: string }
	| { status: "provider_error"; symbol: string };

/** One active-universe row from Massive's list endpoint. */
export interface ActiveTicker {
	symbol: string;
	name: string;
	type: "stock" | "etf";
	lastUpdatedUtc: string;
	compositeFigi: string | null;
}
