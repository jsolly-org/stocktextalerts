/** Massive reference API host, validated on every paginated `next_url`. */
export const MASSIVE_ALLOWED_HOST = "api.massive.com";

/** Massive reference `tickers` endpoint path, shared by the universe and detail fetchers. */
export const MASSIVE_TICKERS_PATH_PREFIX = "/v3/reference/tickers";

/** Massive ticker `type` codes mapped to our normalized stock/etf classification. */
export const ACTIVE_TICKER_TYPES: ReadonlyArray<{
	apiType: string;
	normalizedType: "stock" | "etf";
}> = [
	{ apiType: "CS", normalizedType: "stock" },
	{ apiType: "ADRC", normalizedType: "stock" },
	{ apiType: "OS", normalizedType: "stock" },
	{ apiType: "ETF", normalizedType: "etf" },
	{ apiType: "ETN", normalizedType: "etf" },
	{ apiType: "ETV", normalizedType: "etf" },
	{ apiType: "ETS", normalizedType: "etf" },
];
