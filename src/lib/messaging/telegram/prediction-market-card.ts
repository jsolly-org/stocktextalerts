import { DateTime } from "luxon";
import { compressEventOutcomes } from "../../prediction-markets/shape";
import type { PredictionMarketEventCard } from "../../prediction-markets/types";
import { escapeHtml } from "../parts/html-utils";

/** Logical card width in px — `renderChartPng` scales from this. */
const PM_CARD_DEFAULT_WIDTH = 720;

const COLORS = {
	bg: "#ffffff",
	border: "#e5e7eb",
	meta: "#6b7280",
	title: "#111827",
	label: "#111827",
	muted: "#6b7280",
	footnote: "#9ca3af",
	track: "#e5e7eb",
	fillHigh: "#4f46e5",
	fillLow: "#6366f1",
	fontFamily: "Roboto, sans-serif",
} as const;

const PAD = { x: 16, y: 14 } as const;
const LABEL_COL_W = 100;
const PCT_COL_W = 52;
const COL_GAP = 12;
const ROW_H = 28;
const BAR_H = 10;
const META_H = 16;
const TITLE_LINE_H = 20;
const FOOTNOTE_H = 18;
const TITLE_MAX_CHARS = 72;

export type PredictionMarketCardSvgOptions = {
	timeZone?: string;
	use24Hour?: boolean;
	width?: number;
};

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

function clampPercent(probabilityPercent: number): number {
	if (!Number.isFinite(probabilityPercent)) return 0;
	return Math.min(100, Math.max(0, probabilityPercent));
}

function formatProbability(probabilityPercent: number): string {
	return `${Math.round(clampPercent(probabilityPercent))}%`;
}

function highlightAliasFor(card: PredictionMarketEventCard): string | null {
	const highlighted = card.outcomes.find((o) => o.highlighted);
	if (highlighted) return highlighted.label;
	return card.symbol ?? null;
}

function truncateTitle(title: string): string {
	if (title.length <= TITLE_MAX_CHARS) return title;
	return `${title.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

/**
 * Build a prediction-market ladder card as a raw SVG string for Telegram `sendPhoto`
 * (rasterized via `renderChartPng`). Mirrors email pill-bar layout with fixed columns
 * so bars align regardless of proportional fonts in Telegram text.
 *
 * Returns "" when the card has no displayable outcomes after compression.
 */
export function buildPredictionMarketCardSvg(
	card: PredictionMarketEventCard,
	options: PredictionMarketCardSvgOptions = {},
): string {
	const timeZone = options.timeZone ?? "America/New_York";
	const use24Hour = options.use24Hour ?? false;
	const width = options.width ?? PM_CARD_DEFAULT_WIDTH;

	const body = compressEventOutcomes({
		shape: card.shape,
		shapeValidated: card.shapeValidated,
		outcomes: card.outcomes,
		highlightAlias: highlightAliasFor(card),
	});
	if (body.rows.length === 0) return "";

	const meta = [
		card.symbol ? `${card.symbol} · ${venueLabel(card.venue)}` : venueLabel(card.venue),
		formatCloseLabel(card.closesAt, timeZone, use24Hour),
		formatUpdatedLabel(card.refreshedAt, timeZone, use24Hour),
	].join(" · ");

	const title = truncateTitle(card.title);
	const contentLeft = PAD.x;
	const labelX = contentLeft;
	const barX = labelX + LABEL_COL_W + COL_GAP;
	const pctRight = width - PAD.x;
	const barTrackW = pctRight - PCT_COL_W - COL_GAP - barX;
	if (barTrackW < 80) return "";

	let y = PAD.y;
	const parts: string[] = [];

	// Meta
	parts.push(
		`<text x="${labelX}" y="${y + 12}" font-family="${COLORS.fontFamily}" font-size="11" fill="${COLORS.meta}">${escapeHtml(meta)}</text>`,
	);
	y += META_H + 4;

	// Title
	parts.push(
		`<text x="${labelX}" y="${y + 14}" font-family="${COLORS.fontFamily}" font-size="15" font-weight="700" fill="${COLORS.title}">${escapeHtml(title)}</text>`,
	);
	y += TITLE_LINE_H + 10;

	for (let rowIndex = 0; rowIndex < body.rows.length; rowIndex++) {
		const row = body.rows[rowIndex];
		if (!row) continue;
		const rowCenterY = y + ROW_H / 2;
		// Optical center for Roboto at these sizes (baseline sits below geometric center).
		const textY = rowCenterY + 4;
		if (row.kind === "outcome") {
			const pct = clampPercent(row.probabilityPercent);
			const fillW = (barTrackW * pct) / 100;
			const fillColor = pct >= 50 ? COLORS.fillHigh : COLORS.fillLow;
			const label = `${row.highlighted ? "★ " : ""}${row.label}`;
			const barY = rowCenterY - BAR_H / 2;
			const rx = BAR_H / 2;
			const clipId = `pm-bar-${rowIndex}`;

			parts.push(
				`<text x="${labelX}" y="${textY.toFixed(1)}" font-family="${COLORS.fontFamily}" font-size="13" fill="${COLORS.label}">${escapeHtml(label)}</text>`,
				`<defs><clipPath id="${clipId}"><rect x="${barX}" y="${barY.toFixed(1)}" width="${barTrackW}" height="${BAR_H}" rx="${rx}"/></clipPath></defs>`,
				// Full track first (fixed length), then fill clipped to the pill.
				`<rect x="${barX}" y="${barY.toFixed(1)}" width="${barTrackW}" height="${BAR_H}" rx="${rx}" fill="${COLORS.track}"/>`,
				fillW > 0
					? `<rect x="${barX}" y="${barY.toFixed(1)}" width="${fillW.toFixed(1)}" height="${BAR_H}" fill="${fillColor}" clip-path="url(#${clipId})"/>`
					: "",
				`<text x="${pctRight}" y="${textY.toFixed(1)}" font-family="${COLORS.fontFamily}" font-size="14" font-weight="700" fill="${COLORS.title}" text-anchor="end">${escapeHtml(formatProbability(pct))}</text>`,
			);
		} else if (row.kind === "others") {
			parts.push(
				`<text x="${labelX}" y="${textY.toFixed(1)}" font-family="${COLORS.fontFamily}" font-size="12" fill="${COLORS.muted}">Others (${row.omittedCount})</text>`,
				`<text x="${pctRight}" y="${textY.toFixed(1)}" font-family="${COLORS.fontFamily}" font-size="13" font-weight="600" fill="${COLORS.muted}" text-anchor="end">${escapeHtml(formatProbability(row.probabilityPercent))}</text>`,
			);
		} else {
			parts.push(
				`<text x="${labelX}" y="${textY.toFixed(1)}" font-family="${COLORS.fontFamily}" font-size="12" fill="${COLORS.muted}">${row.omittedCount} more options</text>`,
			);
		}
		y += ROW_H;
	}

	if (body.footnote) {
		y += 4;
		parts.push(
			`<text x="${labelX}" y="${y + 12}" font-family="${COLORS.fontFamily}" font-size="11" fill="${COLORS.footnote}">${escapeHtml(body.footnote)}</text>`,
		);
		y += FOOTNOTE_H;
	}

	const height = y + PAD.y;

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>`,
		...parts.filter(Boolean),
		"</svg>",
	].join("");
}
