/**
 * Result of a sequenced save attempt.
 * - `applied`    — this was still the latest request when it resolved; caller should commit `value`.
 * - `superseded` — a newer request started before this one resolved; caller must drop the result.
 * - `aborted`    — this request's signal was aborted (because a newer request superseded it).
 */
export type SequencedResult<T> =
	| { status: "applied"; value: T }
	| { status: "superseded" }
	| { status: "aborted" };

/**
 * Serializes "last write wins" for idempotent saves.
 *
 * Each `run` gets a monotonic token and a fresh AbortSignal; starting a new
 * `run` aborts the previous one. A task's result is only `applied` if its token
 * is still the latest when it resolves, so an out-of-order/stale response can
 * never clobber newer user intent. Aborting is a best-effort complement: because
 * abort is async and downstream work may still run, the token check — not the
 * abort — is the actual correctness guarantee.
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
			if (token !== latest) return { status: "superseded" };
			return { status: "applied", value };
		} catch (error) {
			// Classify by the error, not `controller.signal.aborted`: supersession
			// always aborts the prior signal, so the signal can't distinguish an
			// abort-caused rejection from a stale request that failed on its own.
			// A real aborted fetch rejects with a DOMException named "AbortError".
			if (error instanceof Error && error.name === "AbortError") {
				return { status: "aborted" };
			}
			// A stale request that failed for any other reason is still stale.
			if (token !== latest) return { status: "superseded" };
			throw error;
		} finally {
			if (activeController === controller) activeController = null;
		}
	}

	return { run };
}
