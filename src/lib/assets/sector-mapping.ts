/**
 * Map SIC code ranges to human-readable sector names.
 *
 * Based on the standard SIC division structure used by the SEC.
 * Used for sector-aware onboarding examples ("other technology stocks").
 */

const SIC_RANGES: Array<{ min: number; max: number; sector: string }> = [
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

export function sicCodeToSector(sicCode: string): string {
	const code = Number.parseInt(sicCode, 10);
	if (!Number.isFinite(code) || code < 0) return "Other";

	for (const range of SIC_RANGES) {
		if (code >= range.min && code <= range.max) {
			return range.sector;
		}
	}
	return "Other";
}
