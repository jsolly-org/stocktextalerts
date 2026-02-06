export interface FormatPreferences {
	show_change_percent: boolean;
	show_company_name: boolean;
	detailed_format: boolean;
}

export interface PreviewStock {
	symbol: string;
	name: string;
	price: number;
	changePercent: number;
}

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
	const base = prefs.show_company_name
		? `${stock.symbol} - ${stock.name}`
		: stock.symbol;

	const priceStr = `$${stock.price.toFixed(2)}`;

	if (prefs.show_change_percent) {
		const sign = stock.changePercent >= 0 ? "+" : "";
		return `${base} — ${priceStr} (${sign}${stock.changePercent.toFixed(2)}%)`;
	}

	return `${base} — ${priceStr}`;
}

export function formatPreviewStocksList(
	stocks: PreviewStock[],
	prefs: FormatPreferences,
): string {
	if (stocks.length === 0) {
		return "You don't have any tracked stocks";
	}
	const separator = prefs.detailed_format ? "\n\n" : "\n";
	return stocks.map((s) => formatPreviewLine(s, prefs)).join(separator);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function formatPreviewEmailHtml(
	stocks: PreviewStock[],
	prefs: FormatPreferences,
): string {
	if (stocks.length === 0) {
		return '<p style="color: #4b5563;">You don\'t have any tracked stocks yet.</p>';
	}

	const joinStr = prefs.detailed_format ? "<br><br>" : "<br>";
	const lines = stocks.map((stock) => {
		const stockInfo = prefs.show_company_name
			? escapeHtml(`${stock.symbol} - ${stock.name}`)
			: escapeHtml(stock.symbol);

		const priceStr = escapeHtml(`$${stock.price.toFixed(2)}`);

		if (prefs.show_change_percent) {
			const sign = stock.changePercent >= 0 ? "+" : "";
			const color = stock.changePercent >= 0 ? "#16a34a" : "#dc2626";
			const changeStr = escapeHtml(
				`(${sign}${stock.changePercent.toFixed(2)}%)`,
			);
			return `${stockInfo} &mdash; ${priceStr} <span style="color: ${color};">${changeStr}</span>`;
		}

		return `${stockInfo} &mdash; ${priceStr}`;
	});

	return lines.join(joinStr);
}
