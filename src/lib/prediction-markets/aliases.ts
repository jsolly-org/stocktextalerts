import type { AssetIdentity } from "./types";

/**
 * Tiny seed map for awkward tickers where legal name alone is a weak search key.
 * Theme words (AI, cloud, …) must never appear here — only issuer identity.
 */
const SEED_ALIASES: Readonly<Record<string, readonly string[]>> = {
	GOOGL: ["Google", "Alphabet", "Gemini", "DeepMind"],
	GOOG: ["Google", "Alphabet", "Gemini", "DeepMind"],
	BRK: ["Berkshire", "Berkshire Hathaway"],
	"BRK.B": ["Berkshire", "Berkshire Hathaway"],
	"BRK.A": ["Berkshire", "Berkshire Hathaway"],
	META: ["Meta", "Facebook", "Instagram", "Llama"],
	SPCX: ["SpaceX"],
};

/** Normalize for comparison: lowercase, strip corp suffixes / punctuation. */
export function normalizeIdentityText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[.,'/&]/g, " ")
		.replace(
			/\b(inc|corp|corporation|ltd|plc|holdings|holding|technologies|technology|company|co|the|markets|group|class [a-z])\b/g,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

function brandToken(name: string): string | null {
	const parts = normalizeIdentityText(name).split(" ").filter(Boolean);
	const first = parts[0];
	if (!first || first.length < 4) return null;
	return first;
}

/**
 * Deterministic identity baseline from symbol + company name + optional seed.
 * Always available even before LLM enrichment.
 */
export function buildDeterministicAliases(symbol: string, name: string): string[] {
	const out = new Set<string>();
	const sym = symbol.trim().toUpperCase();
	if (sym) {
		out.add(sym);
		out.add(`(${sym})`);
		out.add(`$${sym}`);
	}
	const trimmedName = name.trim();
	if (trimmedName) out.add(trimmedName);
	const brand = brandToken(trimmedName);
	if (brand) {
		out.add(brand.charAt(0).toUpperCase() + brand.slice(1));
	}
	for (const seed of SEED_ALIASES[sym] ?? []) {
		out.add(seed);
	}
	return [...out];
}

/** Merge deterministic + persisted aliases into a de-duplicated identity set. */
export function buildAssetIdentity(options: {
	symbol: string;
	name: string;
	persistedAliases?: readonly string[] | null;
}): AssetIdentity {
	const { symbol, name } = options;
	const merged = new Set<string>(buildDeterministicAliases(symbol, name));
	for (const alias of options.persistedAliases ?? []) {
		const trimmed = alias.trim();
		if (trimmed) merged.add(trimmed);
	}
	return {
		symbol: symbol.trim().toUpperCase(),
		name: name.trim(),
		aliases: [...merged],
	};
}

/** Search queries for Polymarket public-search (identity-driven, not theme-driven). */
export function polymarketSearchQueries(identity: AssetIdentity): string[] {
	const sym = identity.symbol;
	if (sym === "SPY") {
		return ["SPY stock", "(SPY)", "SPDR S&P 500"];
	}
	const queries = new Set<string>();
	queries.add(`${sym} stock`);
	if (identity.name) queries.add(identity.name.split(",")[0]?.trim() || identity.name);
	for (const alias of identity.aliases) {
		if (alias === sym || alias.startsWith("(") || alias.startsWith("$")) continue;
		if (alias.length >= 3) queries.add(alias);
	}
	return [...queries];
}

/**
 * True when `text` contains an identity hit for this asset.
 * SPY requires SPY (not SPX). Bare ticker alone is insufficient without context.
 */
export function textHasIdentity(
	text: string,
	identity: AssetIdentity,
): {
	hit: boolean;
	alias: string | null;
} {
	const raw = text;
	const normalized = normalizeIdentityText(text);
	const sym = identity.symbol;

	if (sym === "SPY") {
		if (/\(SPY\)/i.test(raw) || (/\bSPY\b/.test(raw) && /etf|spdr/i.test(raw))) {
			return { hit: true, alias: "SPY" };
		}
		if (/\(SPX\)/i.test(raw) && !/\(SPY\)/i.test(raw)) {
			return { hit: false, alias: null };
		}
	}

	if (new RegExp(`\\(${sym}\\)`, "i").test(raw)) return { hit: true, alias: `(${sym})` };
	if (new RegExp(`\\$${sym}\\b`, "i").test(raw)) return { hit: true, alias: `$${sym}` };

	for (const alias of identity.aliases) {
		if (alias === sym || alias.startsWith("(") || alias.startsWith("$")) continue;
		const n = normalizeIdentityText(alias);
		if (n.length < 3) continue;
		const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`\\b${escaped}\\b`).test(normalized)) {
			return { hit: true, alias };
		}
	}

	const contextualTicker = new RegExp(
		`\\b${sym}\\b.{0,24}\\b(stock|price|share|close|hit|above|earnings|eps|revenue)\\b|\\b(stock|price|share|close|hit|above|earnings|eps|revenue)\\b.{0,24}\\b${sym}\\b`,
		"i",
	);
	if (contextualTicker.test(raw)) return { hit: true, alias: sym };

	return { hit: false, alias: null };
}

/** Exact outcome / groupItemTitle match against identity aliases. */
export function outcomeMatchesIdentity(
	outcomeLabel: string,
	identity: AssetIdentity,
): { hit: boolean; alias: string | null } {
	const n = normalizeIdentityText(outcomeLabel);
	if (!n) return { hit: false, alias: null };
	for (const alias of identity.aliases) {
		if (alias.startsWith("(") || alias.startsWith("$")) continue;
		const an = normalizeIdentityText(alias);
		if (an.length < 3) continue;
		if (n === an) return { hit: true, alias };
	}
	return { hit: false, alias: null };
}
