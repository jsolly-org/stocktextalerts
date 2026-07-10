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

/** The one allowed logo host whose fetches must carry the Massive API key. */
export const MASSIVE_LOGO_HOST = "api.massive.com";

/**
 * Hosts a stored `assets.icon_url` may point at. Massive-era rows carry
 * `api.massive.com` branding URLs (fetched with the API key appended);
 * Finnhub-era rows carry public `static*.finnhub.io` CDN URLs. Anything else
 * is treated as a poisoned value and rejected (SSRF guard).
 */
export const ALLOWED_LOGO_HOSTS: ReadonlySet<string> = new Set([
	MASSIVE_LOGO_HOST,
	"static.finnhub.io",
	"static2.finnhub.io",
]);

/** Upper bound on fetched logo bytes — shared by the dashboard proxy and email inlining. */
export const MAX_LOGO_BYTES = 100 * 1024;

/**
 * Content types the NAVIGABLE logo proxy will serve. Raster only — an SVG (or a
 * mislabeled HTML body) served from `/api/assets/logo/:symbol` executes on the app
 * origin with the viewer's session, and the CDN caches it for a week. The email
 * logo fetcher additionally accepts SVG because it embeds a `data:` URI in mail —
 * never a navigable same-origin response.
 */
export const ALLOWED_LOGO_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
]);
