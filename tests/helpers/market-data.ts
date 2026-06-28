/** Polygon snapshot `updated` field: nanoseconds from Unix seconds (safe integer literal). */
export function polygonUpdatedNs(unixSeconds: number): number {
	return unixSeconds * 1_000_000_000;
}
