import { escapeHtml } from "../parts/html-utils";

/** A time label to render on the sparkline's x-axis. */
export interface SparklineTimeLabel {
	/** Position as fraction 0–1 along the x-axis. */
	position: number;
	/** Label text, e.g. "9:30a". */
	label: string;
}

const AXIS_HEIGHT = 14;
const LABEL_COLOR = "#9ca3af";
const LABEL_FONT_SIZE = 8;
const TICK_HEIGHT = 3;

/** Options for time-axis sparkline positioning. */
interface SparklineTimeAxisOptions {
	/** Per-bar timestamps (ms), same length as values. null for bars lacking t; points at real time for valid entries. */
	timestamps: (number | null)[];
	/** First bar timestamp (ms). */
	startTimestamp: number;
	/** Last bar timestamp (ms). */
	endTimestamp: number;
}

/**
 * Generate an inline SVG area-chart sparkline as a base64 `<img>` tag.
 *
 * Uses the same `data:image/svg+xml;base64,...` pattern as the provider logos in
 * `html-section.ts` for maximum email-client compatibility.
 *
 * When timeAxis is provided, points are placed at real time positions (not uniform
 * index spacing), so the line aligns with the time-axis labels for non-uniform bars.
 */
export function toSvgSparklineImg(
	values: number[],
	color: string,
	width = 80,
	height = 30,
	alt = "sparkline",
	timeLabels?: SparklineTimeLabel[],
	timeAxis?: SparklineTimeAxisOptions,
): string {
	if (values.length < 2) return "";

	const hasAxis = timeLabels && timeLabels.length > 0;
	const totalHeight = hasAxis ? height + AXIS_HEIGHT : height;

	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	const padding = 2;
	const chartW = width - padding * 2;
	const chartH = height - padding * 2;

	const timeSpan =
		timeAxis && timeAxis.endTimestamp > timeAxis.startTimestamp
			? timeAxis.endTimestamp - timeAxis.startTimestamp
			: 0;

	// Use time-based x only when all timestamps are present; otherwise fall back to
	// index-based positioning for the whole series to avoid non-monotonic points.
	const canUseTimeAxis =
		timeAxis &&
		timeSpan > 0 &&
		timeAxis.timestamps.length === values.length &&
		timeAxis.timestamps.every((t) => t != null && Number.isFinite(t));

	const points = values.map((v, i) => {
		let x: number;
		const ts = timeAxis?.timestamps[i] ?? null;
		if (canUseTimeAxis && ts != null && Number.isFinite(ts)) {
			const frac = (ts - timeAxis.startTimestamp) / timeSpan;
			x = padding + Math.max(0, Math.min(1, frac)) * chartW;
		} else {
			x = padding + (i / (values.length - 1)) * chartW;
		}
		const y = padding + chartH - ((v - min) / range) * chartH;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});

	const polylinePoints = points.join(" ");
	// Close the area path along the bottom edge
	const areaPoints = `${polylinePoints} ${(padding + chartW).toFixed(1)},${(padding + chartH).toFixed(1)} ${padding.toFixed(1)},${(padding + chartH).toFixed(1)}`;

	const safeColor = escapeHtml(color);
	const gradientId = "sg";
	const svgParts = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">`,
		`<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">`,
		`<stop offset="0%" stop-color="${safeColor}" stop-opacity="0.3"/>`,
		`<stop offset="100%" stop-color="${safeColor}" stop-opacity="0.05"/>`,
		`</linearGradient></defs>`,
		`<polygon points="${areaPoints}" fill="url(#${gradientId})"/>`,
		`<polyline points="${polylinePoints}" fill="none" stroke="${safeColor}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`,
	];

	if (hasAxis) {
		const axisY = height;
		// Baseline
		svgParts.push(
			`<line x1="${padding}" y1="${axisY}" x2="${padding + chartW}" y2="${axisY}" stroke="${LABEL_COLOR}" stroke-width="0.5"/>`,
		);

		for (let i = 0; i < timeLabels.length; i++) {
			const tl = timeLabels[i];
			if (!tl) continue;
			const x = padding + tl.position * chartW;
			// Tick mark
			svgParts.push(
				`<line x1="${x.toFixed(1)}" y1="${axisY}" x2="${x.toFixed(1)}" y2="${axisY + TICK_HEIGHT}" stroke="${LABEL_COLOR}" stroke-width="0.5"/>`,
			);
			// Text anchor: first=start, last=end, middle=middle
			const anchor = i === 0 ? "start" : i === timeLabels.length - 1 ? "end" : "middle";
			svgParts.push(
				`<text x="${x.toFixed(1)}" y="${axisY + AXIS_HEIGHT - 1}" font-family="sans-serif" font-size="${LABEL_FONT_SIZE}" fill="${LABEL_COLOR}" text-anchor="${anchor}">${escapeHtml(tl.label)}</text>`,
			);
		}
	}

	svgParts.push(`</svg>`);
	const svg = svgParts.join("");

	const base64 = typeof btoa === "function" ? btoa(svg) : Buffer.from(svg).toString("base64");
	// No HTML width/height attributes: in an auto-layout email table they would
	// pin the cell to the img's natural size, defeating any CSS shrinkage.
	// CSS `width` gives the cell a preferred size; `max-width: 100%` lets the
	// img shrink when the container is narrower. The SVG's own `width`/`height`
	// attributes carry the intrinsic size as a fallback for clients that strip
	// inline CSS (e.g. Fastmail).
	return `<img src="data:image/svg+xml;base64,${base64}" alt="${escapeHtml(alt)}" style="vertical-align: middle; width: ${width}px; max-width: 100%; height: auto;" />`;
}
