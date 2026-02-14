/**
 * Generate an inline SVG area-chart sparkline as a base64 `<img>` tag.
 *
 * Uses the same `data:image/svg+xml;base64,...` pattern as the Finnhub/Grok
 * logos in `html-section.ts` for maximum email-client compatibility.
 */
export function toSvgSparklineImg(
	values: number[],
	color: string,
	width = 120,
	height = 30,
): string {
	if (values.length < 2) return "";

	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	const padding = 2;
	const chartW = width - padding * 2;
	const chartH = height - padding * 2;

	const points = values.map((v, i) => {
		const x = padding + (i / (values.length - 1)) * chartW;
		const y = padding + chartH - ((v - min) / range) * chartH;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});

	const polylinePoints = points.join(" ");
	// Close the area path along the bottom edge
	const areaPoints = `${polylinePoints} ${(padding + chartW).toFixed(1)},${(padding + chartH).toFixed(1)} ${padding.toFixed(1)},${(padding + chartH).toFixed(1)}`;

	const gradientId = "sg";
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">`,
		`<stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>`,
		`<stop offset="100%" stop-color="${color}" stop-opacity="0.05"/>`,
		`</linearGradient></defs>`,
		`<polygon points="${areaPoints}" fill="url(#${gradientId})"/>`,
		`<polyline points="${polylinePoints}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`,
		`</svg>`,
	].join("");

	const base64 =
		typeof btoa === "function"
			? btoa(svg)
			: Buffer.from(svg).toString("base64");
	return `<img src="data:image/svg+xml;base64,${base64}" alt="sparkline" width="${width}" height="${height}" style="vertical-align: middle;" />`;
}
