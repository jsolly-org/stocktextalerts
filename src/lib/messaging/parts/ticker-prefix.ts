import { FormattedString, fmt } from "@grammyjs/parse-mode";

/**
 * Line-leading ticker prefix: base symbol, optional space + class/unit suffix
 * (IPO units like `SKHY V`), then `:` (events/news) or ` — ` (top movers).
 * Labels like `Gainers:` stay unmatched — they contain lowercase letters.
 */
const TICKER_PREFIX_RE = /^([A-Z][A-Z0-9.-]{0,9}(?: [A-Z0-9.-]{1,5})?)(:| — )(.*)$/;

type TickerPrefixMatch = {
	ticker: string;
	separator: ":" | " — ";
	rest: string;
};

/** Parse a line-leading ticker prefix, or null when the line is not ticker-shaped. */
export function matchTickerPrefix(line: string): TickerPrefixMatch | null {
	const m = TICKER_PREFIX_RE.exec(line);
	if (!m) return null;
	const [, ticker, separator, rest] = m;
	if (!ticker || (separator !== ":" && separator !== " — ")) return null;
	return { ticker, separator, rest: rest ?? "" };
}

/** True when a line starts with a ticker prefix (blank-line separation for news/rumors). */
export function isTickerPrefixLine(line: string): boolean {
	return matchTickerPrefix(line) !== null;
}

/**
 * Bold line-leading tickers in already-escaped email HTML.
 * Colon lines keep the colon inside `<strong>` (`AAPL:`); em-dash lines bold
 * only the ticker (`JLHL` — …).
 */
export function boldTickerPrefixesHtml(content: string): string {
	return content
		.split("\n")
		.map((line) => {
			const m = matchTickerPrefix(line);
			if (!m) return line;
			if (m.separator === ":") {
				return `<strong>${m.ticker}:</strong>${m.rest}`;
			}
			return `<strong>${m.ticker}</strong>${m.separator}${m.rest}`;
		})
		.join("\n");
}

/** Bold line-leading tickers as Telegram FormattedString entities. */
export function boldTickerPrefixesTelegram(content: string): FormattedString {
	const lines = content.split("\n");
	let result: FormattedString | null = null;
	for (const line of lines) {
		const m = matchTickerPrefix(line);
		let lineFmt: FormattedString;
		if (m) {
			lineFmt =
				m.separator === ":"
					? fmt`${FormattedString.bold(`${m.ticker}:`)}${m.rest}`
					: fmt`${FormattedString.bold(m.ticker)}${m.separator}${m.rest}`;
		} else {
			lineFmt = fmt`${line}`;
		}
		result = result === null ? lineFmt : fmt`${result}\n${lineFmt}`;
	}
	return result ?? fmt``;
}
