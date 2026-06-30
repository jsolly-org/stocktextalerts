import type { SicRange } from "./types";

// --- Universe reconcile tuning ---

/** Default per-run enrichment cap — candidates beyond this defer to subsequent runs. */
export const DEFAULT_ENRICHMENT_CAP = 500;

/** Default bounded concurrency for the per-symbol detail fetch. */
export const DEFAULT_ENRICHMENT_CONCURRENCY = 20;

/** Upsert/flag chunk size — keeps `.in()` filter URLs under practical length limits. */
export const CHUNK_SIZE = 500;

/**
 * Absolute floor on the fetched active-set size below which step 3 skips delist-flagging as a
 * suspected silent truncation. The real US stock+ETF active universe is ~11k; a truncated fetch
 * degrades to one or a few 1000-row pages. Deliberately an ABSOLUTE floor, NOT a fraction of the
 * stored active count — that count is inflated by the very backlog this job exists to drain.
 */
export const MIN_PLAUSIBLE_ACTIVE_UNIVERSE = 5000;

// --- Delisting sweep ---

/**
 * Milliseconds in the notification_log dedupe window. A successful
 * `type='delisting'` row within this window for a given user suppresses a
 * second email, even if the sweep re-runs due to a crash or retry. The
 * window is wider than the cron interval so a crash-across-midnight case
 * can't produce duplicate emails.
 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;

// --- Sector mapping (SIC range → sector → sector ETF) ---

/**
 * Map SIC code ranges to human-readable sector names.
 *
 * Based on the standard SIC division structure used by the SEC.
 * Used for sector-aware onboarding examples ("other technology stocks").
 */
export const SIC_RANGES: SicRange[] = [
	// Agriculture, Forestry, Fishing
	{ min: 100, max: 999, sector: "Materials" },
	// Mining
	{ min: 1000, max: 1499, sector: "Energy" },
	// Construction
	{ min: 1500, max: 1799, sector: "Industrials" },
	// Manufacturing — mixed
	{ min: 2000, max: 2799, sector: "Consumer" },
	{ min: 2800, max: 2899, sector: "Healthcare" },
	{ min: 2900, max: 2999, sector: "Energy" },
	{ min: 3000, max: 3569, sector: "Industrials" },
	// Electronics & computers
	{ min: 3570, max: 3599, sector: "Technology" },
	{ min: 3600, max: 3699, sector: "Technology" },
	{ min: 3700, max: 3799, sector: "Industrials" },
	// Instruments (medical, scientific)
	{ min: 3800, max: 3899, sector: "Healthcare" },
	{ min: 3900, max: 3999, sector: "Consumer" },
	// Transportation & Utilities
	{ min: 4000, max: 4799, sector: "Industrials" },
	{ min: 4800, max: 4899, sector: "Communication" },
	{ min: 4900, max: 4999, sector: "Utilities" },
	// Wholesale Trade
	{ min: 5000, max: 5199, sector: "Consumer" },
	// Retail Trade
	{ min: 5200, max: 5999, sector: "Consumer" },
	// Finance, Insurance, Real Estate
	{ min: 6000, max: 6199, sector: "Financials" },
	{ min: 6200, max: 6299, sector: "Financials" },
	{ min: 6300, max: 6499, sector: "Financials" },
	{ min: 6500, max: 6599, sector: "Real Estate" },
	{ min: 6700, max: 6799, sector: "Financials" },
	// Services
	{ min: 7000, max: 7299, sector: "Consumer" },
	{ min: 7300, max: 7399, sector: "Technology" },
	{ min: 7370, max: 7379, sector: "Technology" },
	{ min: 7400, max: 7999, sector: "Consumer" },
	// Health Services
	{ min: 8000, max: 8099, sector: "Healthcare" },
	// Educational, Social, Other Services
	{ min: 8100, max: 8999, sector: "Consumer" },
	// Public Administration
	{ min: 9000, max: 9999, sector: "Industrials" },
];

/** Sector name → representative sector-ETF symbol. */
export const SECTOR_ETF_MAP: Record<string, string> = {
	Technology: "XLK",
	Healthcare: "XLV",
	Financials: "XLF",
	Energy: "XLE",
	Consumer: "XLY",
	Industrials: "XLI",
	"Real Estate": "XLRE",
	Utilities: "XLU",
	Materials: "XLB",
	Communication: "XLC",
};
