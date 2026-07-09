import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { escapeHtml, getSafeHrefUrl } from "../messaging/parts/html-utils";
import type { PredictionMarketReading } from "./types";

const BAR_WIDTH = 10;
const EMAIL_LINK_STYLE = "color: #4f46e5; text-decoration: none; font-weight: 600;";

function clampPercent(probabilityPercent: number): number {
	if (!Number.isFinite(probabilityPercent)) return 0;
	return Math.min(100, Math.max(0, probabilityPercent));
}

function formatDelta(deltaPoints: number | null): string {
	if (deltaPoints === null || deltaPoints === 0) return "—";
	const rounded = Math.round(deltaPoints);
	if (rounded === 0) {
		const sign = deltaPoints > 0 ? "▲" : "▼";
		return `${sign}${Math.abs(deltaPoints).toFixed(1)}`;
	}
	const sign = rounded > 0 ? "▲" : "▼";
	return `${sign}${Math.abs(rounded)}`;
}

function formatProbability(probabilityPercent: number): string {
	return `${Math.round(clampPercent(probabilityPercent))}%`;
}

function deltaTone(deltaPoints: number | null): "up" | "down" | "flat" {
	if (deltaPoints === null || deltaPoints === 0) return "flat";
	return deltaPoints > 0 ? "up" : "down";
}

/** Unicode probability bar for plain-text / Telegram channels. */
function unicodeBar(probabilityPercent: number, width = BAR_WIDTH): string {
	const filled = Math.round((clampPercent(probabilityPercent) / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function venueLabel(venue: PredictionMarketReading["venue"]): string {
	if (venue === "kalshi") return "Kalshi";
	if (venue === "polymarket") return "Polymarket";
	return venue;
}

/**
 * Plain-text body (email text/plain): stacked rows with a unicode probability bar.
 * Labels are not linked here — URLs are reserved for HTML / Telegram entities.
 *
 * ```
 * Recession '26     11%  █░░░░░░░░░  —
 * Fed cut by '27    23%  ██░░░░░░░░  ▼5
 * ```
 */
export function formatPredictionMarketsText(
	readings: readonly PredictionMarketReading[],
): string | null {
	if (readings.length === 0) return null;

	const labelWidth = Math.max(...readings.map((r) => r.label.length));
	return readings
		.map((reading) => {
			const label = reading.label.padEnd(labelWidth, " ");
			const odds = formatProbability(reading.probabilityPercent).padStart(4, " ");
			const bar = unicodeBar(reading.probabilityPercent);
			const delta = formatDelta(reading.deltaPoints);
			return `${label}  ${odds}  ${bar}  ${delta}`;
		})
		.join("\n");
}

/**
 * Telegram body: same stacked layout, with each market label as a text_link entity.
 */
export function formatPredictionMarketsTelegram(
	readings: readonly PredictionMarketReading[],
): FormattedString | null {
	if (readings.length === 0) return null;

	const labelWidth = Math.max(...readings.map((r) => r.label.length));
	let msg: FormattedString | null = null;

	for (const reading of readings) {
		const pad = " ".repeat(Math.max(0, labelWidth - reading.label.length));
		const odds = formatProbability(reading.probabilityPercent).padStart(4, " ");
		const bar = unicodeBar(reading.probabilityPercent);
		const delta = formatDelta(reading.deltaPoints);
		const safeUrl = getSafeHrefUrl(reading.url);
		const labelPart = safeUrl ? FormattedString.link(reading.label, safeUrl) : reading.label;
		const row = fmt`${labelPart}${pad}  ${odds}  ${bar}  ${delta}`;
		msg = msg ? fmt`${msg}\n${row}` : row;
	}

	return msg;
}

/**
 * Email HTML body: card rows with CSS probability bars and colored deltas.
 * Market labels link to the venue page. Inline styles only (email-client safe).
 */
export function formatPredictionMarketsEmailHtml(
	readings: readonly PredictionMarketReading[],
): string | null {
	if (readings.length === 0) return null;

	const rows = readings
		.map((reading, index) => {
			const pct = clampPercent(reading.probabilityPercent);
			const filled = Math.round(pct);
			const empty = 100 - filled;
			const tone = deltaTone(reading.deltaPoints);
			const deltaColor = tone === "up" ? "#059669" : tone === "down" ? "#dc2626" : "#6b7280";
			const fillColor = pct >= 50 ? "#4f46e5" : "#6366f1";
			const borderTop = index === 0 ? "none" : "1px solid #e5e7eb";
			const venue = venueLabel(reading.venue);
			const safeUrl = getSafeHrefUrl(reading.url);
			const labelHtml = safeUrl
				? `<a href="${escapeHtml(safeUrl)}" style="${EMAIL_LINK_STYLE}" target="_blank" rel="noopener noreferrer">${escapeHtml(reading.label)}</a>`
				: escapeHtml(reading.label);

			return `<tr>
  <td style="padding: 10px 0; border-top: ${borderTop}; vertical-align: middle;">
    <div style="font-size: 13px; line-height: 1.3;">${labelHtml}</div>
    <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${escapeHtml(venue)}</div>
  </td>
  <td style="padding: 10px 12px; border-top: ${borderTop}; width: 46%; vertical-align: middle;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
      <tr>
        <td style="background: ${fillColor}; height: 8px; width: ${filled}%; border-radius: 999px 0 0 999px; font-size: 0; line-height: 0;">&nbsp;</td>
        <td style="background: #e5e7eb; height: 8px; width: ${empty}%; border-radius: 0 999px 999px 0; font-size: 0; line-height: 0;">&nbsp;</td>
      </tr>
    </table>
  </td>
  <td style="padding: 10px 0 10px 8px; border-top: ${borderTop}; text-align: right; white-space: nowrap; vertical-align: middle;">
    <div style="font-size: 15px; font-weight: 700; color: #111827; font-variant-numeric: tabular-nums;">${escapeHtml(formatProbability(pct))}</div>
    <div style="font-size: 12px; font-weight: 600; color: ${deltaColor}; margin-top: 2px; font-variant-numeric: tabular-nums;">${escapeHtml(formatDelta(reading.deltaPoints))}</div>
  </td>
</tr>`;
		})
		.join("");

	return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; margin: 0;">${rows}</table>`;
}
