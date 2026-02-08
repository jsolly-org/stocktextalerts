import type { FormatPreferences } from "./types";

export type StockPrice = { price: number; changePercent: number };
type StockWithName = { symbol: string; name: string };

export const NO_TRACKED_STOCKS_MESSAGE = "You don't have any tracked stocks";

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatStockBaseText(
	stock: StockWithName,
	formatPrefs: FormatPreferences,
): string {
	return formatPrefs.show_company_name
		? `${stock.symbol} - ${stock.name}`
		: stock.symbol;
}

function formatStockPriceText(
	price: StockPrice,
	showChangePercent: boolean,
): string {
	if (!showChangePercent) {
		return `$${price.price.toFixed(2)}`;
	}
	const sign = price.changePercent >= 0 ? "+" : "";
	return `$${price.price.toFixed(2)} (${sign}${price.changePercent.toFixed(2)}%)`;
}

export function formatStockTextLine(
	stock: StockWithName,
	price: StockPrice | undefined,
	formatPrefs: FormatPreferences,
): string {
	const base = formatStockBaseText(stock, formatPrefs);
	if (!price) {
		return base;
	}
	return `${base} — ${formatStockPriceText(price, formatPrefs.show_change_percent)}`;
}

function getChangeColor(changePercent: number): string {
	return changePercent >= 0 ? "#16a34a" : "#dc2626";
}

function formatStockHtmlLine(
	stock: StockWithName,
	price: StockPrice | undefined,
	formatPrefs: FormatPreferences,
): string {
	const stockInfo = formatPrefs.show_company_name
		? escapeHtml(`${stock.symbol} - ${stock.name}`)
		: escapeHtml(stock.symbol);

	if (!price) {
		return stockInfo;
	}

	const priceStr = escapeHtml(`$${price.price.toFixed(2)}`);

	if (formatPrefs.show_change_percent) {
		const sign = price.changePercent >= 0 ? "+" : "";
		const color = getChangeColor(price.changePercent);
		const changeStr = escapeHtml(`(${sign}${price.changePercent.toFixed(2)}%)`);
		return `${stockInfo} &mdash; ${priceStr} <span style="color: ${color};">${changeStr}</span>`;
	}

	return `${stockInfo} &mdash; ${priceStr}`;
}

export function formatStocksTextList(
	stocks: StockWithName[],
	getPrice: (symbol: string) => StockPrice | undefined,
	formatPrefs: FormatPreferences,
): string {
	if (stocks.length === 0) {
		return NO_TRACKED_STOCKS_MESSAGE;
	}

	const separator = formatPrefs.detailed_format ? "\n\n" : "\n";
	return stocks
		.map((stock) =>
			formatStockTextLine(stock, getPrice(stock.symbol), formatPrefs),
		)
		.join(separator);
}

export function formatStocksHtmlList(
	stocks: StockWithName[],
	getPrice: (symbol: string) => StockPrice | undefined,
	formatPrefs: FormatPreferences,
): string {
	const joinStr = formatPrefs.detailed_format ? "<br><br>" : "<br>";
	return stocks
		.map((stock) =>
			formatStockHtmlLine(stock, getPrice(stock.symbol), formatPrefs),
		)
		.join(joinStr);
}
