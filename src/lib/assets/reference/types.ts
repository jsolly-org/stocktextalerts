/** Authoritative delisting record for a single symbol. */
interface TickerReferenceResult {
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
