import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REDUCED_MOTION_QUERY,
	shouldDisableAutoAdvance,
} from "../../../src/lib/accessibility/prefers-reduced-motion";

describe("retune wizard prefers-reduced-motion", () => {
	let matchMediaMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		matchMediaMock = vi.fn((query: string) => {
			expect(query).toBe(REDUCED_MOTION_QUERY);
			return {
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			};
		});
		vi.stubGlobal("matchMedia", matchMediaMock);
		vi.stubGlobal("window", {
			matchMedia: matchMediaMock,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		} as object);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("disables auto-advance when prefers-reduced-motion: reduce matches", () => {
		const mq = (
			globalThis as unknown as {
				matchMedia: (q: string) => { matches: boolean };
			}
		).matchMedia(REDUCED_MOTION_QUERY);
		expect(shouldDisableAutoAdvance(mq)).toBe(true);
		expect(matchMediaMock).toHaveBeenCalledWith(REDUCED_MOTION_QUERY);
	});

	it("allows auto-advance when prefers-reduced-motion does not match", () => {
		const mq = { matches: false };
		expect(shouldDisableAutoAdvance(mq)).toBe(false);
	});
});
