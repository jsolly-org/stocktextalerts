import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { ActiveMarketSession, AssetPriceMap } from "../../types";
import {
	formatSignedChangePercent,
	formatUsdPrice,
	getNoSessionTradeText,
	resolveDisplayChangePercent,
} from "../parts/asset-price-list";
import type { SparklineData } from "../parts/sparkline";
import { directionDot } from "./direction-dot";

/** Append Telegram-native asset price lines to an existing FormattedString message. */
export function appendTelegramAssetPriceLines(options: {
	msg: FormattedString;
	userAssets: Array<{ symbol: string }>;
	assetPrices: AssetPriceMap;
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
	showChangePercent?: (symbol: string) => boolean;
	noSessionTrade?: Set<string>;
	marketSession?: ActiveMarketSession;
}): FormattedString {
	let { msg } = options;
	for (const asset of options.userAssets) {
		const quote = options.assetPrices.get(asset.symbol);
		if (!quote) {
			const noSessionTradeText = options.noSessionTrade?.has(asset.symbol)
				? getNoSessionTradeText(asset.symbol, options.marketSession)
				: null;
			msg = fmt`${msg}\n${noSessionTradeText ?? `${asset.symbol} — price unavailable`}`;
			continue;
		}
		const sparkline = options.getSparkline?.(asset.symbol);
		const showChange = options.showChangePercent?.(asset.symbol) ?? true;
		const changePercent =
			showChange && quote
				? resolveDisplayChangePercent(quote, sparkline ?? null)
				: quote.changePercent;
		const dot = directionDot(changePercent);
		const changeSuffix = showChange ? `  (${formatSignedChangePercent(changePercent)})` : "";
		msg = fmt`${msg}\n${dot} ${FormattedString.bold(asset.symbol)}  ${formatUsdPrice(quote.price)}${changeSuffix}`;
	}
	return msg;
}
