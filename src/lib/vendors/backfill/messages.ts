import type { AssetEventProvider } from "../../asset-events/types";
import type { PriceHistoryRow } from "../../market-data/types";

export type AssetEventsBackfillMessage = {
	kind: "asset-events";
	weekStart: string;
	weekEnd: string;
	providers: AssetEventProvider[];
	reason?: string;
};

export type DailyClosesBackfillMessage = {
	kind: "daily-closes";
	symbols: string[];
	from: string;
	to: string;
	reason?: string;
};

export type PriceHistoryStoreBackfillMessage = {
	kind: "price-history-store";
	rows: PriceHistoryRow[];
	reason?: string;
};

export type NewSymbolWarmupBackfillMessage = {
	kind: "new-symbol-warmup";
	symbol: string;
	reason?: string;
};

export type VendorBackfillMessage =
	| AssetEventsBackfillMessage
	| DailyClosesBackfillMessage
	| PriceHistoryStoreBackfillMessage
	| NewSymbolWarmupBackfillMessage;

function isAssetEventProvider(value: unknown): value is AssetEventProvider {
	return value === "earnings" || value === "dividends" || value === "splits" || value === "ipos";
}

function parsePriceHistoryRow(value: unknown): PriceHistoryRow | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.symbol !== "string" || typeof row.captured_at !== "string") {
		return null;
	}
	if (typeof row.price !== "number" || !Number.isFinite(row.price)) {
		return null;
	}
	return {
		symbol: row.symbol,
		price: row.price,
		captured_at: row.captured_at,
	};
}

export function parseVendorBackfillMessage(body: string): VendorBackfillMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const kind = record.kind;
	if (kind === "asset-events") {
		if (
			typeof record.weekStart !== "string" ||
			typeof record.weekEnd !== "string" ||
			!Array.isArray(record.providers) ||
			record.providers.length === 0 ||
			!record.providers.every(isAssetEventProvider)
		) {
			return null;
		}
		return {
			kind: "asset-events",
			weekStart: record.weekStart,
			weekEnd: record.weekEnd,
			providers: record.providers,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	if (kind === "daily-closes") {
		if (
			!Array.isArray(record.symbols) ||
			record.symbols.length === 0 ||
			typeof record.from !== "string" ||
			typeof record.to !== "string" ||
			!record.symbols.every((s) => typeof s === "string")
		) {
			return null;
		}
		return {
			kind: "daily-closes",
			symbols: record.symbols,
			from: record.from,
			to: record.to,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	if (kind === "price-history-store") {
		if (!Array.isArray(record.rows) || record.rows.length === 0) {
			return null;
		}
		const rows: PriceHistoryRow[] = [];
		for (const row of record.rows) {
			const parsedRow = parsePriceHistoryRow(row);
			if (!parsedRow) return null;
			rows.push(parsedRow);
		}
		return {
			kind: "price-history-store",
			rows,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	if (kind === "new-symbol-warmup") {
		if (typeof record.symbol !== "string" || record.symbol.trim() === "") {
			return null;
		}
		return {
			kind: "new-symbol-warmup",
			symbol: record.symbol.trim().toUpperCase(),
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	return null;
}
