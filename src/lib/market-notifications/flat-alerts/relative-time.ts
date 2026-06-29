/** Format an elapsed duration in minutes/hours as "27 min ago", "1h 23m ago".
 *  Floors to a minimum of "1 min ago" — we never run sub-minute cadence. */
export function formatRelativeMinutesAgo(fromMs: number, toMs: number): string {
	const diffMs = Math.max(0, toMs - fromMs);
	const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000));
	if (totalMinutes < 60) {
		return `${totalMinutes} min ago`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	return `${hours}h ${mins}m ago`;
}
