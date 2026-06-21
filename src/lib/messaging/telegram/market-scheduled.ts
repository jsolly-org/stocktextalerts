import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import type { UserAssetRow } from "../types";

const UP = "🟢";
const DOWN = "🔴";
const FLAT = "⚪️";

function formatPct(p: number): string {
	const sign = p > 0 ? "+" : "";
	return `${sign}${p.toFixed(2)}%`;
}

function formatPrice(p: number): string {
	return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface MarketScheduledTelegramOptions {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	/** Human session/time label, e.g. "9:30 AM" or "Pre-market". */
	sessionLabel?: string | null;
	/** Optional market-closed banner text (weekend/holiday). */
	marketClosedBanner?: string | null;
}

/**
 * Render a scheduled multi-asset price snapshot as a Telegram message using
 * parse-mode entities (no MarkdownV2/HTML escaping — values travel as literal
 * text alongside entity offsets). Telegram-native: color dots for direction,
 * bold tickers. No chart (this is a multi-asset snapshot; charts are
 * single-asset-alerts-only per the plan). Reuses the digest's asset-line
 * rendering style. Returns a FormattedString whose `.text`/`.entities` feed the
 * sender.
 */
export function formatMarketScheduledTelegram(
	opts: MarketScheduledTelegramOptions,
): FormattedString {
	const { userAssets, assetPrices } = opts;

	const header = opts.sessionLabel ? `📈 Price Update · ${opts.sessionLabel}` : "📈 Price Update";
	let msg = fmt`${FormattedString.bold(header)}`;
	if (opts.marketClosedBanner) {
		msg = fmt`${msg}\n${opts.marketClosedBanner}`;
	}

	for (const asset of userAssets) {
		const quote = assetPrices.get(asset.symbol);
		if (!quote) continue;
		const dot = quote.changePercent > 0 ? UP : quote.changePercent < 0 ? DOWN : FLAT;
		msg = fmt`${msg}\n${dot} ${FormattedString.bold(asset.symbol)}  $${formatPrice(quote.price)}  (${formatPct(quote.changePercent)})`;
	}

	msg = fmt`${msg}\n\nNot financial advice.`;
	return msg;
}
