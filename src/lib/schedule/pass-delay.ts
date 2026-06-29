/** Delay between pass 1 and pass 2 of the two-pass scheduler (ms). */
const SCHEDULE_PASS_DELAY_MS = 30_000;

export function getPassDelayMs(): number {
	return SCHEDULE_PASS_DELAY_MS;
}
