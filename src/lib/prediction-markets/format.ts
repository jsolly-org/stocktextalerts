import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { DateTime } from "luxon";
import { escapeHtml, getSafeHrefUrl } from "../messaging/parts/html-utils";
import { type CompressedEventBody, compressEventOutcomes } from "./shape";
import type { PredictionMarketEventCard, PredictionMarketsDigestContent } from "./types";

const EMAIL_LINK_STYLE = "color: #4f46e5; text-decoration: none; font-weight: 600;";
const BAR_WIDTH = 10;

function clampPercent(probabilityPercent: number): number {
	if (!Number.isFinite(probabilityPercent)) return 0;
	return Math.min(100, Math.max(0, probabilityPercent));
}

function formatProbability(probabilityPercent: number): string {
	return `${Math.round(clampPercent(probabilityPercent))}%`;
}

function unicodeBar(probabilityPercent: number, width = BAR_WIDTH): string {
	const filled = Math.round((clampPercent(probabilityPercent) / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function venueLabel(venue: PredictionMarketEventCard["venue"]): string {
	if (venue === "kalshi") return "Kalshi";
	if (venue === "polymarket") return "Polymarket";
	return venue;
}

function formatCloseLabel(closesAt: string | null, timeZone: string, use24Hour: boolean): string {
	if (!closesAt) return "No fixed close";
	const dt = DateTime.fromISO(closesAt, { zone: "utc" }).setZone(timeZone);
	if (!dt.isValid) return "No fixed close";
	return `Closes ${dt.toFormat(use24Hour ? "MMM d, HH:mm" : "MMM d, h:mm a")} ${dt.offsetNameShort}`;
}

function formatUpdatedLabel(refreshedAt: string, timeZone: string, use24Hour: boolean): string {
	const dt = DateTime.fromISO(refreshedAt, { zone: "utc" }).setZone(timeZone);
	if (!dt.isValid) return "Updated —";
	return `Updated ${dt.toFormat(use24Hour ? "MMM d, HH:mm" : "MMM d, h:mm a")}`;
}

function compressCard(
	card: PredictionMarketEventCard,
	highlightAlias: string | null,
): CompressedEventBody {
	return compressEventOutcomes({
		shape: card.shape,
		shapeValidated: card.shapeValidated,
		outcomes: card.outcomes,
		highlightAlias,
	});
}

function highlightAliasFor(card: PredictionMarketEventCard): string | null {
	const highlighted = card.outcomes.find((o) => o.highlighted);
	if (highlighted) return highlighted.label;
	return card.symbol ?? null;
}

export type FormatCardOptions = {
	timeZone?: string;
	use24Hour?: boolean;
};

/** Plain-text body for one event card. */
export function formatEventCardText(
	card: PredictionMarketEventCard,
	options: FormatCardOptions = {},
): string {
	const timeZone = options.timeZone ?? "America/New_York";
	const use24Hour = options.use24Hour ?? false;
	const body = compressCard(card, highlightAliasFor(card));
	const header = [
		card.symbol ? `${card.symbol} · ${venueLabel(card.venue)}` : venueLabel(card.venue),
		formatCloseLabel(card.closesAt, timeZone, use24Hour),
		formatUpdatedLabel(card.refreshedAt, timeZone, use24Hour),
	].join(" · ");

	const lines = [header, card.title];
	for (const row of body.rows) {
		if (row.kind === "outcome") {
			const mark = row.highlighted ? "★ " : "";
			lines.push(
				`  ${mark}${row.label}  ${formatProbability(row.probabilityPercent).padStart(4, " ")}  ${unicodeBar(row.probabilityPercent)}`,
			);
		} else if (row.kind === "others") {
			lines.push(`  Others (${row.omittedCount}) · ${formatProbability(row.probabilityPercent)}`);
		} else {
			lines.push(`  ${row.omittedCount} more options`);
		}
	}
	if (body.footnote) lines.push(`  ${body.footnote}`);
	lines.push(`  ${body.linkLabel}: ${card.url}`);
	return lines.join("\n");
}

/** Telegram body for one event card. */
function formatEventCardTelegram(
	card: PredictionMarketEventCard,
	options: FormatCardOptions = {},
): FormattedString {
	const timeZone = options.timeZone ?? "America/New_York";
	const use24Hour = options.use24Hour ?? false;
	const body = compressCard(card, highlightAliasFor(card));
	const meta = [
		card.symbol ? `${card.symbol} · ${venueLabel(card.venue)}` : venueLabel(card.venue),
		formatCloseLabel(card.closesAt, timeZone, use24Hour),
		formatUpdatedLabel(card.refreshedAt, timeZone, use24Hour),
	].join(" · ");

	let msg = fmt`${FormattedString.bold(meta)}\n${card.title}`;
	for (const row of body.rows) {
		if (row.kind === "outcome") {
			const mark = row.highlighted ? "★ " : "";
			const odds = formatProbability(row.probabilityPercent).padStart(4, " ");
			msg = fmt`${msg}\n  ${mark}${row.label}  ${odds}  ${unicodeBar(row.probabilityPercent)}`;
		} else if (row.kind === "others") {
			msg = fmt`${msg}\n  Others (${row.omittedCount}) · ${formatProbability(row.probabilityPercent)}`;
		} else {
			msg = fmt`${msg}\n  ${row.omittedCount} more options`;
		}
	}
	if (body.footnote) {
		msg = fmt`${msg}\n  ${body.footnote}`;
	}
	const safeUrl = getSafeHrefUrl(card.url);
	if (safeUrl) {
		msg = fmt`${msg}\n  ${FormattedString.link(body.linkLabel, safeUrl)}`;
	}
	return msg;
}

/** Email HTML for one event card. */
export function formatEventCardEmailHtml(
	card: PredictionMarketEventCard,
	options: FormatCardOptions = {},
): string {
	const timeZone = options.timeZone ?? "America/New_York";
	const use24Hour = options.use24Hour ?? false;
	const body = compressCard(card, highlightAliasFor(card));
	const venue = venueLabel(card.venue);
	const meta = escapeHtml(
		[
			card.symbol ? `${card.symbol} · ${venue}` : venue,
			formatCloseLabel(card.closesAt, timeZone, use24Hour),
			formatUpdatedLabel(card.refreshedAt, timeZone, use24Hour),
		].join(" · "),
	);

	const rowHtml = body.rows
		.map((row) => {
			if (row.kind === "outcome") {
				const pct = clampPercent(row.probabilityPercent);
				const filled = Math.round(pct);
				const empty = 100 - filled;
				const fillColor = pct >= 50 ? "#4f46e5" : "#6366f1";
				const label = `${row.highlighted ? "★ " : ""}${escapeHtml(row.label)}`;
				return `<tr>
  <td style="padding: 6px 0; font-size: 13px; color: #111827; width: 42%;">${label}</td>
  <td style="padding: 6px 10px; width: 40%;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
      <tr>
        <td style="background: ${fillColor}; height: 8px; width: ${filled}%; border-radius: 999px 0 0 999px; font-size: 0; line-height: 0;">&nbsp;</td>
        <td style="background: #e5e7eb; height: 8px; width: ${empty}%; border-radius: 0 999px 999px 0; font-size: 0; line-height: 0;">&nbsp;</td>
      </tr>
    </table>
  </td>
  <td style="padding: 6px 0; text-align: right; font-size: 14px; font-weight: 700; color: #111827; font-variant-numeric: tabular-nums; white-space: nowrap;">${escapeHtml(formatProbability(pct))}</td>
</tr>`;
			}
			if (row.kind === "others") {
				return `<tr>
  <td colspan="2" style="padding: 6px 0; font-size: 12px; color: #6b7280;">Others (${row.omittedCount})</td>
  <td style="padding: 6px 0; text-align: right; font-size: 13px; font-weight: 600; color: #6b7280; font-variant-numeric: tabular-nums;">${escapeHtml(formatProbability(row.probabilityPercent))}</td>
</tr>`;
			}
			return `<tr>
  <td colspan="3" style="padding: 6px 0; font-size: 12px; color: #6b7280;">${row.omittedCount} more options</td>
</tr>`;
		})
		.join("");

	const footnote = body.footnote
		? `<div style="font-size: 11px; color: #9ca3af; margin-top: 6px;">${escapeHtml(body.footnote)}</div>`
		: "";
	const safeUrl = getSafeHrefUrl(card.url);
	const link = safeUrl
		? `<div style="margin-top: 8px; font-size: 12px;"><a href="${escapeHtml(safeUrl)}" style="${EMAIL_LINK_STYLE}" target="_blank" rel="noopener noreferrer">${escapeHtml(body.linkLabel)}</a></div>`
		: "";

	return `<div style="border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; margin: 0 0 12px; background: #ffffff;">
  <div style="font-size: 11px; color: #6b7280; margin: 0 0 4px;">${meta}</div>
  <div style="font-size: 15px; font-weight: 700; color: #111827; line-height: 1.35; margin: 0 0 10px;">${escapeHtml(card.title)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">${rowHtml}</table>
  ${footnote}
  ${link}
</div>`;
}

function formatCardsText(
	cards: readonly PredictionMarketEventCard[],
	options: FormatCardOptions,
): string | null {
	if (cards.length === 0) return null;
	return cards.map((c) => formatEventCardText(c, options)).join("\n\n");
}

function formatCardsTelegram(
	cards: readonly PredictionMarketEventCard[],
	options: FormatCardOptions,
): FormattedString | null {
	if (cards.length === 0) return null;
	let msg: FormattedString | null = null;
	for (const card of cards) {
		const block = formatEventCardTelegram(card, options);
		msg = msg ? fmt`${msg}\n\n${block}` : block;
	}
	return msg;
}

function formatCardsEmailHtml(
	cards: readonly PredictionMarketEventCard[],
	options: FormatCardOptions,
): string | null {
	if (cards.length === 0) return null;
	return cards.map((c) => formatEventCardEmailHtml(c, options)).join("");
}

/** Plain-text body with optional Your Assets / Macro Weather group headers. */
export function formatPredictionMarketsDigestText(
	content: PredictionMarketsDigestContent,
	options: FormatCardOptions = {},
): string | null {
	const parts: string[] = [];
	const assets = formatCardsText(content.assetCards, options);
	if (assets) parts.push(`Your Assets\n${assets}`);
	const macro = formatCardsText(content.macroCards, options);
	if (macro) parts.push(`Macro Weather\n${macro}`);
	return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Telegram body with group headers; asset markets precede macro. */
export function formatPredictionMarketsDigestTelegram(
	content: PredictionMarketsDigestContent,
	options: FormatCardOptions = {},
): FormattedString | null {
	let msg: FormattedString | null = null;
	const assets = formatCardsTelegram(content.assetCards, options);
	if (assets) {
		msg = fmt`${FormattedString.bold("Your Assets")}\n${assets}`;
	}
	const macro = formatCardsTelegram(content.macroCards, options);
	if (macro) {
		const section = fmt`${FormattedString.bold("Macro Weather")}\n${macro}`;
		msg = msg ? fmt`${msg}\n\n${section}` : section;
	}
	return msg;
}

/** Email HTML with group headers. */
export function formatPredictionMarketsDigestEmailHtml(
	content: PredictionMarketsDigestContent,
	options: FormatCardOptions = {},
): string | null {
	const parts: string[] = [];
	const assets = formatCardsEmailHtml(content.assetCards, options);
	if (assets) {
		parts.push(
			`<div style="font-size: 12px; font-weight: 700; color: #374151; letter-spacing: 0.02em; margin: 0 0 8px;">Your Assets</div>${assets}`,
		);
	}
	const macro = formatCardsEmailHtml(content.macroCards, options);
	if (macro) {
		const margin = parts.length > 0 ? "18px" : "0";
		parts.push(
			`<div style="font-size: 12px; font-weight: 700; color: #374151; letter-spacing: 0.02em; margin: ${margin} 0 8px;">Macro Weather</div>${macro}`,
		);
	}
	return parts.length > 0 ? parts.join("") : null;
}

/**
 * Legacy scalar formatters — wrap readings as binary cards for any leftover call sites.
 * Prefer the digest card formatters above.
 */
export function formatPredictionMarketsText(
	readings: readonly import("./types").PredictionMarketReading[],
): string | null {
	if (readings.length === 0) return null;
	return readings
		.map((r) => {
			const yes = Math.round(clampPercent(r.probabilityPercent));
			return `${r.label}  ${yes}%  ${unicodeBar(yes)}`;
		})
		.join("\n");
}

export function formatPredictionMarketsTelegram(
	readings: readonly import("./types").PredictionMarketReading[],
): FormattedString | null {
	if (readings.length === 0) return null;
	let msg: FormattedString | null = null;
	for (const reading of readings) {
		const yes = Math.round(clampPercent(reading.probabilityPercent));
		const safeUrl = getSafeHrefUrl(reading.url);
		const labelPart = safeUrl ? FormattedString.link(reading.label, safeUrl) : reading.label;
		const row = fmt`${labelPart}  ${yes}%  ${unicodeBar(yes)}`;
		msg = msg ? fmt`${msg}\n${row}` : row;
	}
	return msg;
}

export function formatPredictionMarketsEmailHtml(
	readings: readonly import("./types").PredictionMarketReading[],
): string | null {
	if (readings.length === 0) return null;
	const now = new Date().toISOString();
	const cards: PredictionMarketEventCard[] = readings.map((r) => ({
		key: r.key,
		title: r.label,
		venue: r.venue,
		url: r.url,
		shape: "binary",
		closesAt: null,
		refreshedAt: now,
		volume: 0,
		shapeValidated: true,
		symbol: r.symbol,
		matchKind: r.matchKind,
		outcomes: [
			{
				venueContractId: `${r.key}:yes`,
				label: "Yes",
				probabilityPercent: r.probabilityPercent,
				sortOrder: 0,
				strikeValue: null,
				volume: 0,
			},
			{
				venueContractId: `${r.key}:no`,
				label: "No",
				probabilityPercent: Math.round((100 - r.probabilityPercent) * 10) / 10,
				sortOrder: 1,
				strikeValue: null,
				volume: 0,
			},
		],
	}));
	return formatCardsEmailHtml(cards, {});
}
