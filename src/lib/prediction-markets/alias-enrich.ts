import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { fetchGrokResponse, type GrokTextFormat, parseResponsesJsonObject } from "../vendors/grok";
import { GROK_ALIAS_MODEL } from "../vendors/grok-models";
import { buildDeterministicAliases, normalizeIdentityText } from "./aliases";

const GROK_ALIAS_TEXT_FORMAT = {
	type: "json_schema",
	name: "pm_aliases",
	strict: true,
	schema: {
		type: "object",
		properties: {
			aliases: { type: "array", items: { type: "string" } },
		},
		required: ["aliases"],
		additionalProperties: false,
	},
} as const satisfies GrokTextFormat;

const THEME_BLOCKLIST = new Set(
	[
		"ai",
		"cloud",
		"semiconductor",
		"tech",
		"technology",
		"software",
		"hardware",
		"finance",
		"bank",
		"retail",
		"energy",
		"oil",
		"crypto",
		"bitcoin",
		"stock",
		"stocks",
		"etf",
		"market",
		"markets",
	].map((s) => s.toLowerCase()),
);

/**
 * Validate LLM-suggested aliases: drop theme words, empties, and collisions
 * with other tracked symbols' identity sets.
 */
export function validateEnrichedAliases(options: {
	symbol: string;
	suggested: readonly string[];
	otherIdentityNormalized: ReadonlySet<string>;
}): string[] {
	const { symbol, suggested, otherIdentityNormalized } = options;
	const baseline = new Set(
		buildDeterministicAliases(symbol, "").map((a) => normalizeIdentityText(a)),
	);
	const out: string[] = [];
	const seen = new Set<string>();

	for (const raw of suggested) {
		const trimmed = raw.trim();
		if (trimmed.length < 3 || trimmed.length > 64) continue;
		const n = normalizeIdentityText(trimmed);
		if (!n || seen.has(n)) continue;
		if (THEME_BLOCKLIST.has(n)) continue;
		if (baseline.has(n)) continue;
		if (otherIdentityNormalized.has(n)) continue;
		// Reject multi-word industry phrases
		if (/\b(sector|industry|stocks?|etfs?)\b/i.test(trimmed)) continue;
		seen.add(n);
		out.push(trimmed);
	}
	return out;
}

/**
 * Ask Grok for additional unique identity strings for a tracked symbol.
 * Soft-fails to [] when the key is missing or the call fails.
 */
export async function enrichAliasesWithGrok(options: {
	symbol: string;
	name: string;
	logger: Logger;
	otherIdentityNormalized: ReadonlySet<string>;
}): Promise<string[]> {
	const { symbol, name, logger, otherIdentityNormalized } = options;

	const response = await fetchGrokResponse({
		requestBody: {
			model: GROK_ALIAS_MODEL,
			instructions: [
				"You suggest identity aliases for matching prediction-market titles to a public company.",
				"Include brand names, common short names, and product/lab names that uniquely imply THIS issuer.",
				"Do NOT include industry/theme keywords (AI, cloud, semiconductor, stocks, etc.).",
				"Do NOT include other companies. Max 8 aliases.",
				"Return aliases via the structured response schema.",
			].join(" "),
			input: `Symbol: ${symbol}\nLegal name: ${name}`,
			temperature: 0,
			max_output_tokens: 200,
			reasoning_effort: "none",
			text: { format: GROK_ALIAS_TEXT_FORMAT },
		},
		logContext: { action: "pm_alias_enrich", symbol },
	});

	if (!response) {
		logger.warn("Alias enrich skipped (no Grok response)", { symbol });
		return [];
	}

	const obj = parseResponsesJsonObject(response);
	const rawAliases = obj?.aliases;
	const suggested = Array.isArray(rawAliases)
		? rawAliases.filter((x): x is string => typeof x === "string")
		: [];
	if (suggested.length === 0 && !obj) {
		logger.warn("Alias enrich JSON parse failed; soft-fail empty", { symbol });
		return [];
	}

	const validated = validateEnrichedAliases({
		symbol,
		suggested,
		otherIdentityNormalized,
	});
	logger.info("Alias enrich complete", {
		symbol,
		suggestedCount: suggested.length,
		acceptedCount: validated.length,
	});
	return validated;
}

/** Load persisted aliases for a symbol (or null if none). */
export async function loadPersistedAliases(
	supabase: SupabaseAdminClient,
	symbol: string,
): Promise<{ aliases: string[]; status: string } | null> {
	const { data, error } = await supabase
		.from("asset_prediction_aliases")
		.select("aliases,status")
		.eq("symbol", symbol)
		.maybeSingle();
	if (error) throw error;
	if (!data) return null;
	return {
		aliases: Array.isArray(data.aliases)
			? data.aliases.filter((a): a is string => typeof a === "string")
			: [],
		status: data.status,
	};
}

/** Upsert enriched aliases for a tracked symbol. */
export async function storePersistedAliases(options: {
	supabase: SupabaseAdminClient;
	symbol: string;
	aliases: string[];
	status: "enriched" | "skipped" | "failed";
}): Promise<void> {
	const { supabase, symbol, aliases, status } = options;
	const { error } = await supabase.from("asset_prediction_aliases").upsert(
		{
			symbol,
			aliases,
			status,
			enriched_at: new Date().toISOString(),
		},
		{ onConflict: "symbol" },
	);
	if (error) throw error;
}
