/* =============
Scheduler tuning
============= */

/** Daily fan-out batch size for digest dispatch/precompute. Override via SCHEDULE_DAILY_DISPATCH_BATCH_SIZE. */
export const DAILY_DISPATCH_BATCH_SIZE = (() => {
	const raw = process.env.SCHEDULE_DAILY_DISPATCH_BATCH_SIZE;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();
