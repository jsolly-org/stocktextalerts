import { buildDeterministicAliases } from "../../prediction-markets/aliases";

/**
 * Identity names for why/digest search seeding. Deterministic aliases plus
 * optional persisted brands, minus `$TICKER` / `(TICKER)` cashtag forms.
 */
export function identitySearchNames(options: {
	symbol: string;
	companyName: string;
	persistedAliases?: readonly string[] | null;
}): string[] {
	const sym = options.symbol.trim().toUpperCase();
	const skip = new Set([`$${sym}`, `(${sym})`]);
	const seen = new Set<string>();
	const out: string[] = [];

	const candidates = [
		...buildDeterministicAliases(options.symbol, options.companyName),
		...(options.persistedAliases ?? []),
	];
	for (const raw of candidates) {
		const name = raw.trim();
		if (!name) continue;
		if (skip.has(name.toUpperCase())) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

const IDENTITY_SEARCH_HEADER = "Issuer identity names for search (not required talking points)";

export function formatIdentitySearchBlock(names: readonly string[]): string {
	if (names.length === 0) return "";
	return `${IDENTITY_SEARCH_HEADER}: ${names.join(", ")}`;
}

/** Multi-ticker identity block for prompts that cover a whole watchlist. */
export function formatTickerIdentitySearchBlock(
	entries: readonly { symbol: string; names: readonly string[] }[],
): string {
	const lines = entries
		.filter((entry) => entry.names.length > 0)
		.map((entry) => `${entry.symbol.trim().toUpperCase()}: ${entry.names.join(", ")}`);
	if (lines.length === 0) return "";
	return `${IDENTITY_SEARCH_HEADER}:\n${lines.join("\n")}`;
}
