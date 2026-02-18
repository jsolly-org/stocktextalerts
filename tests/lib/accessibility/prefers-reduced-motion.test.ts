import { describe, expect, it } from "vitest";
import { REDUCED_MOTION_QUERY } from "../../../src/lib/accessibility/prefers-reduced-motion";

describe("REDUCED_MOTION_QUERY", () => {
	it("matches the standard prefers-reduced-motion media query", () => {
		expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
	});
});
