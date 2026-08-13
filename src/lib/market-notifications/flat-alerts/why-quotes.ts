import { fetchSnapshotQuotes } from "../../market-data/quotes";
import { getCurrentEquityTradeSession } from "../../market-data/session";
import { NO_SESSION_TRADE } from "../../types";
import type { GrokFunctionTool } from "../../vendors/grok";

export const GET_QUOTES_MAX_SYMBOLS = 8;
export const GET_QUOTES_MAX_ROUNDS = 2;

export const GET_QUOTES_FUNCTION_TOOL = {
	type: "function",
	name: "get_quotes",
	description:
		"Look up today's session percent change for symbols that search already named as relevant to this move. Do not fish for peers. At most 8 symbols per call.",
	parameters: {
		type: "object",
		properties: {
			symbols: {
				type: "array",
				items: { type: "string" },
				description: "Ticker symbols to look up",
			},
		},
		required: ["symbols"],
		additionalProperties: false,
	},
} as const satisfies GrokFunctionTool;

function parseSymbols(argsJson: string): string[] | { error: string } {
	try {
		const parsed: unknown = JSON.parse(argsJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { error: "arguments must be an object with symbols[]" };
		}
		const symbols = (parsed as { symbols?: unknown }).symbols;
		if (!Array.isArray(symbols)) {
			return { error: "symbols must be an array of ticker strings" };
		}
		const cleaned = symbols
			.filter((s): s is string => typeof s === "string")
			.map((s) => s.trim().toUpperCase())
			.filter((s) => s.length > 0);
		if (cleaned.length === 0) {
			return { error: "symbols must contain at least one ticker" };
		}
		if (cleaned.length > GET_QUOTES_MAX_SYMBOLS) {
			return { error: `at most ${GET_QUOTES_MAX_SYMBOLS} symbols per call` };
		}
		return [...new Set(cleaned)];
	} catch {
		return { error: "invalid JSON arguments" };
	}
}

/**
 * Execute get_quotes. Errors are returned as `{ error }` for the model — never a fake flat tape.
 */
export async function executeGetQuotes(argsJson: string): Promise<unknown> {
	const parsed = parseSymbols(argsJson);
	if (!Array.isArray(parsed)) {
		return parsed;
	}

	const session = await getCurrentEquityTradeSession();
	if (session === "closed") {
		return { error: "market session is closed; quotes unavailable" };
	}

	try {
		const map = await fetchSnapshotQuotes(parsed, session);
		const quotes: Record<string, unknown> = {};
		for (const symbol of parsed) {
			const entry = map.get(symbol);
			if (entry === undefined || entry === null) {
				quotes[symbol] = { error: "quote unavailable" };
				continue;
			}
			if (entry === NO_SESSION_TRADE) {
				quotes[symbol] = { error: "no session trade" };
				continue;
			}
			quotes[symbol] = {
				price: entry.price,
				changePercent: entry.changePercent,
			};
		}
		return { quotes };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
