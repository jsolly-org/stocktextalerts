export interface PreviewStock {
	symbol: string;
	name: string;
	price: number;
	changePercent: number;
}

import {
	formatStocksHtmlList,
	formatStocksTextList,
	formatStockTextLine,
	type StockPrice,
} from "../../../lib/messaging/stock-formatting";
import type { FormatPreferences } from "../../../lib/messaging/types";

export const DEMO_STOCKS: PreviewStock[] = [
	{ symbol: "AAPL", name: "Apple Inc", price: 195.5, changePercent: 2.4 },
	{ symbol: "GOOGL", name: "Alphabet Inc", price: 178.2, changePercent: 1.8 },
	{
		symbol: "TSLA",
		name: "Tesla Inc",
		price: 248.3,
		changePercent: -0.5,
	},
];

export function formatPreviewLine(
	stock: PreviewStock,
	prefs: FormatPreferences,
): string {
	return formatStockTextLine(
		stock,
		{ price: stock.price, changePercent: stock.changePercent },
		prefs,
	);
}

export function formatPreviewStocksList(
	stocks: PreviewStock[],
	prefs: FormatPreferences,
): string {
	const prices = new Map<string, StockPrice>(
		stocks.map((stock) => [
			stock.symbol,
			{ price: stock.price, changePercent: stock.changePercent },
		]),
	);
	return formatStocksTextList(stocks, (symbol) => prices.get(symbol), prefs);
}

export function formatPreviewEmailHtml(
	stocks: PreviewStock[],
	prefs: FormatPreferences,
): string {
	if (stocks.length === 0) {
		return '<p style="color: #4b5563;">You don\'t have any tracked stocks yet.</p>';
	}

	const prices = new Map<string, StockPrice>(
		stocks.map((stock) => [
			stock.symbol,
			{ price: stock.price, changePercent: stock.changePercent },
		]),
	);
	return formatStocksHtmlList(stocks, (symbol) => prices.get(symbol), prefs);
}
