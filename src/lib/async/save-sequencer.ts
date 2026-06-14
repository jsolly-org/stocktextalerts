/**
 * Result of a sequenced save attempt.
 * - `applied` — this was still the latest request when it settled; caller should commit `value`.
 * - `stale`   — a newer request superseded this one before it settled; caller must drop the result.
 */
export type SequencedResult<T> = { status: "applied"; value: T } | { status: "stale" };

/**
 * Serializes "last write wins" for idempotent saves.
 *
 * Each `run` gets a monotonic token and a fresh AbortSignal; starting a new
 * `run` aborts the previous one. A task's result is only `applied` if its token
 * is still the latest when it settles, so an out-of-order/stale response can
 * never clobber newer user intent. Aborting is a best-effort complement —
 * because abort is async and downstream work may still run, the token check, not
 * the abort, is the actual correctness guarantee.
 *
 * A superseded request that rejects (e.g. its fetch aborts) is reported `stale`
 * and its error swallowed, because the caller no longer cares. Only the latest
 * request's genuine failure propagates, so real errors (timeouts, network
 * failures) still reach the caller to be surfaced and logged.
 */
export function createSaveSequencer() {
	let latest = 0;
	let activeController: AbortController | null = null;

	async function run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<SequencedResult<T>> {
		const token = ++latest;
		// Supersede any in-flight request.
		activeController?.abort();
		const controller = new AbortController();
		activeController = controller;

		try {
			const value = await task(controller.signal);
			if (token !== latest) return { status: "stale" };
			return { status: "applied", value };
		} catch (error) {
			// A superseded request is stale regardless of how it failed (its abort
			// surfaces here as a rejection). Only the latest request's genuine
			// failure propagates to the caller.
			if (token !== latest) return { status: "stale" };
			throw error;
		} finally {
			if (activeController === controller) activeController = null;
		}
	}

	return { run };
}
