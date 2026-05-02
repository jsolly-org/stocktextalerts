import { afterEach, describe, expect, it, vi } from "vitest";
import { getScrollBehavior, prefersReducedMotion } from "../../src/lib/accessibility";

describe("prefersReducedMotion", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns true when prefers-reduced-motion: reduce matches", () => {
		vi.stubGlobal("window", {
			matchMedia: (query: string) => ({
				matches: query === "(prefers-reduced-motion: reduce)",
			}),
		});
		expect(prefersReducedMotion()).toBe(true);
	});

	it("returns false when reduced motion is not preferred", () => {
		vi.stubGlobal("window", {
			matchMedia: () => ({ matches: false }),
		});
		expect(prefersReducedMotion()).toBe(false);
	});

	it("returns false when window is undefined (e.g. SSR)", () => {
		vi.stubGlobal("window", undefined);
		expect(prefersReducedMotion()).toBe(false);
	});
});

describe("getScrollBehavior", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns 'auto' when prefers-reduced-motion: reduce matches", () => {
		vi.stubGlobal("window", {
			matchMedia: (query: string) => ({
				matches: query === "(prefers-reduced-motion: reduce)",
			}),
		});
		expect(getScrollBehavior()).toBe("auto");
	});

	it("returns 'smooth' when reduced motion is not preferred", () => {
		vi.stubGlobal("window", {
			matchMedia: () => ({ matches: false }),
		});
		expect(getScrollBehavior()).toBe("smooth");
	});

	it("returns 'auto' when window is undefined (e.g. SSR)", () => {
		vi.stubGlobal("window", undefined);
		expect(getScrollBehavior()).toBe("auto");
	});
});
