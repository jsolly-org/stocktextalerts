import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { TELEGRAM_FOOTER } from "../footer";
import { buildMarketClosedBannerText } from "../market-closure-banner";

interface AssetEventsTelegramOptions {
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	/** Optional "your notification is late" banner — same as email/SMS get. */
	delayBanner?: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
}

/**
 * Render a standalone asset-events digest as a Telegram message using parse-mode
 * entities (no MarkdownV2/HTML escaping — values travel as literal text alongside
 * entity offsets). Telegram-native: bold section headers, full-text section bodies
 * (no SMS segment limit). No chart. Mirrors the email/SMS asset-events content
 * (earnings/dividends/splits/IPOs/insider/analyst); the caller decides which
 * sections to include based on the user's per-facet Telegram selection. Returns a
 * FormattedString whose `.text`/`.entities` feed the sender.
 */
export function formatAssetEventsTelegram(opts: AssetEventsTelegramOptions): FormattedString {
	let msg = fmt`${FormattedString.bold("🗓️ Asset Events")}`;

	if (opts.delayBanner) {
		msg = fmt`${msg}\n${opts.delayBanner}`;
	}
	if (opts.marketClosureInfo) {
		msg = fmt`${msg}\n${buildMarketClosedBannerText(opts.marketClosureInfo, "events")}`;
	}

	if (opts.earningsSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📅 Earnings")}\n${opts.earningsSection}`;
	}
	if (opts.dividendsSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💰 Ex-Dividend")}\n${opts.dividendsSection}`;
	}
	if (opts.splitsSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("✂️ Splits")}\n${opts.splitsSection}`;
	}
	if (opts.iposSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🆕 Upcoming IPOs")}\n${opts.iposSection}`;
	}
	if (opts.insiderSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🏦 Insider Trades")}\n${opts.insiderSection}`;
	}
	if (opts.analystSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📊 Analyst Consensus (published monthly on the 1st)")}\n${opts.analystSection}`;
	}

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
