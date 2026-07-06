import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlidingWindowLimiter } from "../../src/lib/rate-limit";

// The limiter delays via node:timers/promises (which vitest fake timers deliberately do NOT
// fake). Replace it with a mock that advances a virtual clock, and inject that clock as the
// limiter's `now`, so the sliding window advances deterministically with zero real time.
const realDelayMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));
vi.mock("node:timers/promises", () => ({ setTimeout: realDelayMock }));

describe("createSlidingWindowLimiter", () => {
	let clock = 0;

	beforeEach(() => {
		clock = 0;
		// Capture the wake target synchronously at call time so several waiters that computed
		// the same waitMs from the same clock converge on one target instead of stacking.
		realDelayMock.mockImplementation((ms) => {
			const target = clock + ms;
			return Promise.resolve().then(() => {
				clock = Math.max(clock, target);
			});
		});
	});
	afterEach(() => {
		realDelayMock.mockReset();
	});

	function makeLimiter(maxPerWindow: number, windowMs: number) {
		return createSlidingWindowLimiter({ maxPerWindow, windowMs, now: () => clock });
	}

	it("admits the first maxPerWindow calls immediately with no delay", async () => {
		const limiter = makeLimiter(4, 1_000);
		const admittedAt: number[] = [];

		await Promise.all(
			Array.from({ length: 4 }, () => limiter.acquire().then(() => admittedAt.push(clock))),
		);

		expect(admittedAt).toEqual([0, 0, 0, 0]);
		expect(realDelayMock).not.toHaveBeenCalled();
	});

	it("delays the overflow into later windows and never admits more than maxPerWindow per window", async () => {
		const limiter = makeLimiter(2, 1_000);
		const admittedAt: number[] = [];

		await Promise.all(
			Array.from({ length: 5 }, () => limiter.acquire().then(() => admittedAt.push(clock))),
		);

		admittedAt.sort((a, b) => a - b);
		// 2 admitted now; 2 more once the first window rolls (1000); the 5th only after the next
		// window (2000) — the window cap is never exceeded in any 1000ms span.
		expect(admittedAt).toEqual([0, 0, 1_000, 1_000, 2_000]);
	});

	it("fails open instead of spinning when the delay is a no-op that never advances the clock", async () => {
		// Regression: vendor tests mock node:timers/promises to an instant no-op to skip retry
		// sleeps (e.g. movers.test.ts, company-news/fetch.test.ts). Before the fail-open guard,
		// an exhausted window + a no-op delay re-looped at microtask speed and OOMed the vitest
		// worker (4 GB in seconds). The limiter must detect the non-advancing clock and admit.
		realDelayMock.mockImplementation(async () => {}); // resolves instantly, clock frozen
		const limiter = makeLimiter(2, 60_000);

		await limiter.acquire();
		await limiter.acquire();
		// Window is now full and can never roll (clock frozen) — must fail open, not spin.
		await expect(limiter.acquire()).resolves.toBeUndefined();
		expect(realDelayMock).toHaveBeenCalled();
	});
});
