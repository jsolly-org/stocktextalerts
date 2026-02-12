import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AssetData = {
	symbol: string;
	name: string;
	type: string;
};

let assetDataCache: Map<string, AssetData> | null = null;

function loadAssetData(): Map<string, AssetData> {
	if (assetDataCache) {
		return assetDataCache;
	}

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const assetsFile = path.join(
		__dirname,
		"..",
		"..",
		"scripts",
		"data",
		"us-assets.json",
	);

	let assetsData: { data: AssetData[] };
	try {
		assetsData = JSON.parse(fs.readFileSync(assetsFile, "utf-8"));
	} catch (error) {
		throw new Error(
			`Failed to load asset data from ${assetsFile}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!Array.isArray(assetsData.data)) {
		throw new Error(
			`Invalid asset data format: expected array in 'data' property`,
		);
	}

	assetDataCache = new Map(
		assetsData.data.map((asset) => [asset.symbol.toUpperCase(), asset]),
	);

	return assetDataCache;
}

export function getAssetData(symbol: string): AssetData {
	const assetData = loadAssetData();
	const normalizedSymbol = symbol.toUpperCase();
	const asset = assetData.get(normalizedSymbol);

	if (!asset) {
		throw new Error(
			`Asset symbol "${symbol}" (normalized: "${normalizedSymbol}") not found in asset data. Use a valid asset symbol from the us-assets.json dataset.`,
		);
	}

	return asset;
}

export function getRealAssetSymbols(count: number): string[] {
	if (count < 0) {
		throw new Error(`Requested negative symbol count: ${count}`);
	}

	const assetData = loadAssetData();
	const symbols = Array.from(assetData.keys());

	if (symbols.length < count) {
		throw new Error(
			`Requested ${count} asset symbols but only ${symbols.length} available in asset data`,
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

export function getRealAssetSymbolsByType(
	type: "stock" | "etf",
	count: number,
): string[] {
	if (count < 0) {
		throw new Error(`Requested negative symbol count: ${count}`);
	}

	const assetData = loadAssetData();
	const symbols = Array.from(assetData.entries())
		.filter(([, asset]) => asset.type === type)
		.map(([symbol]) => symbol);

	if (symbols.length < count) {
		throw new Error(
			`Requested ${count} ${type} symbols but only ${symbols.length} available in asset data`,
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
