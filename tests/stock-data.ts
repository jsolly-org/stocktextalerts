import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type StockData = {
	symbol: string;
	name: string;
	exchange: string;
};

let stockDataCache: Map<string, StockData> | null = null;

function loadStockData(): Map<string, StockData> {
	if (stockDataCache) {
		return stockDataCache;
	}

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const stocksFile = path.join(__dirname, "..", "scripts", "us-stocks.json");

	let stocksData: { data: StockData[] };
	try {
		stocksData = JSON.parse(fs.readFileSync(stocksFile, "utf-8"));
	} catch (error) {
		throw new Error(
			`Failed to load stock data from ${stocksFile}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!Array.isArray(stocksData.data)) {
		throw new Error(
			`Invalid stock data format: expected array in 'data' property`,
		);
	}

	stockDataCache = new Map(
		stocksData.data.map((stock) => [stock.symbol.toUpperCase(), stock]),
	);

	return stockDataCache;
}

export function getStockData(symbol: string): StockData {
	const stockData = loadStockData();
	const normalizedSymbol = symbol.toUpperCase();
	const stock = stockData.get(normalizedSymbol);

	if (!stock) {
		throw new Error(
			`Stock symbol "${symbol}" (normalized: "${normalizedSymbol}") not found in stock data. Use a valid stock symbol from the us-stocks.json dataset.`,
		);
	}

	return stock;
}

export function getRealStockSymbols(count: number): string[] {
	if (count < 0) {
		throw new Error(`Requested negative symbol count: ${count}`);
	}

	const stockData = loadStockData();
	const symbols = Array.from(stockData.keys());

	if (symbols.length < count) {
		throw new Error(
			`Requested ${count} stock symbols but only ${symbols.length} available in stock data`,
		);
	}

	// Shuffle array using Fisher-Yates algorithm for varied test data
	const shuffled = [...symbols];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = randomInt(0, i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}

	return shuffled.slice(0, count);
}
