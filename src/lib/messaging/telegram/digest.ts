import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import { formatSignedChangePercent, formatUsdPrice } from "../asset-formatting";
import { TELEGRAM_FOOTER } from "../footer";
import type { SmsExtras } from "../sms/delivery";
import type { UserAssetRow } from "../types";

const UP = "🟢";
const DOWN = "🔴";
const FLAT = "⚪️";

interface DailyDigestTelegramOptions {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: SmsExtras;
	/** Human date label in market tz, e.g. "Thu, Jun 19". */
	dateLabel: string;
	/** Optional "your notification is late" banner — same as email/SMS get. */
	delayBanner?: string | null;
	/** Optional market-closed banner text (weekend/holiday). */
	marketClosedBanner?: string | null;
}

/**
 * Render a daily digest as a Telegram message using parse-mode entities (no
 * MarkdownV2/HTML escaping — values travel as literal text alongside entity
 * offsets). Telegram-native: full-text news/rumors (no SMS segment limit),
 * color dots for direction, bold tickers. No chart (digests are multi-asset;
 * charts are single-asset-alerts-only per the plan). Returns a FormattedString
 * whose `.text`/`.entities` feed the sender.
 */
export function formatDailyDigestTelegram(opts: DailyDigestTelegramOptions): FormattedString {
	const { userAssets, assetPrices, extras } = opts;

	let msg = fmt`${FormattedString.bold(`📊 Daily Digest · ${opts.dateLabel}`)}`;
	if (opts.delayBanner) {
		msg = fmt`${msg}\n${opts.delayBanner}`;
	}
	if (opts.marketClosedBanner) {
		msg = fmt`${msg}\n${opts.marketClosedBanner}`;
	}

	for (const asset of userAssets) {
		const quote = assetPrices.get(asset.symbol);
		if (!quote) continue;
		const dot = quote.changePercent > 0 ? UP : quote.changePercent < 0 ? DOWN : FLAT;
		msg = fmt`${msg}\n${dot} ${FormattedString.bold(asset.symbol)}  ${formatUsdPrice(quote.price)}  (${formatSignedChangePercent(quote.changePercent)})`;
	}

	if (extras.topMovers) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📈 Top movers")}\n${extras.topMovers}`;
	}
	if (extras.news) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📰 News")}\n${FormattedString.blockquote(extras.news)}`;
	}
	if (extras.rumors) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💬 Rumors")}\n${FormattedString.blockquote(extras.rumors)}`;
	}

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
