import { setTimeout as realDelay } from "node:timers/promises";

/**
 * A proactive request throttle: `acquire()` resolves only once a slot is free within the
 * sliding window, delaying the caller otherwise. Per-process (not distributed).
 */
export interface SlidingWindowLimiter {
	/** Resolves when a slot is admitted within the window; may delay. */
	acquire(): Promise<void>;
}

/**
 * Create a sliding-window rate limiter that admits at most `maxPerWindow` calls per
 * rolling `windowMs`.
 *
 * Delays via `node:timers/promises` so they survive vitest's `vi.useFakeTimers()` (which
 * replaces the global `setTimeout`). The clock defaults to `performance.now()` because fake
 * timers replace `Date.now()` but not `performance.now()` — so a caller that fakes timers for
 * its own reasons doesn't accidentally freeze this limiter. `now` is injectable purely so tests
 * can drive a deterministic clock.
 *
 * No lock is needed: the trim-check-record step is fully synchronous (the only `await` is the
 * delay, after the record decision), so single-threaded JS serializes concurrent acquirers and
 * they cannot over-admit. Keep it that way — introducing an `await` between the length check and
 * `push` would reopen an over-admission race.
 */
export function createSlidingWindowLimiter(options: {
	maxPerWindow: number;
	windowMs: number;
	now?: () => number;
}): SlidingWindowLimiter {
	const { maxPerWindow, windowMs, now = () => performance.now() } = options;
	const recentTimestamps: number[] = [];

	return {
		async acquire(): Promise<void> {
			for (;;) {
				const currentMs = now();
				while (recentTimestamps.length > 0) {
					const oldest = recentTimestamps[0];
					if (oldest === undefined || oldest > currentMs - windowMs) break;
					recentTimestamps.shift();
				}
				if (recentTimestamps.length < maxPerWindow) {
					recentTimestamps.push(currentMs);
					return;
				}
				const earliest = recentTimestamps[0];
				const waitMs = earliest !== undefined ? earliest + windowMs - currentMs : 0;
				if (waitMs > 0) {
					await realDelay(waitMs);
					if (now() - currentMs < Math.min(waitMs, 1)) {
						// The awaited delay didn't actually advance the clock: node:timers/promises
						// is mocked to a no-op (tests fast-forwarding vendor retry sleeps do this)
						// or the clock is broken. Fail open and admit instead of re-looping — with
						// a full window and a no-op delay the loop would otherwise spin at
						// microtask speed, allocating promises unboundedly (the vitest-worker heap
						// OOM this guards against). A real sleep always advances `performance.now()`
						// by at least `waitMs`, so this branch is unreachable in production; an
						// over-admitted call degrades to the vendor's own 429/Retry-After handling.
						recentTimestamps.push(now());
						return;
					}
				}
			}
		},
	};
}
