/**
 * Vitest setup file: no spec may reach a third-party API.
 *
 * Separate from `tests/setup.ts` because it enforces a rule rather than providing
 * fixtures, and because it must hold even for a spec that mocks nothing.
 *
 * `*.live.test.ts` is the documented exception (excluded from the default run by
 * vitest.config.ts, opted into with `LIVE_PREDICTION_MARKETS=1 npx vitest`), so the guard
 * stands down for those files. See tests/helpers/network-guard.ts for the rationale.
 */

import { afterAll, beforeAll, expect } from "vitest";
import { installNetworkGuard } from "./helpers/network-guard";

let restore: (() => void) | null = null;

beforeAll(() => {
	const testPath = expect.getState().testPath ?? "";
	if (testPath.includes(".live.test.")) return;
	restore = installNetworkGuard(`vitest ${testPath || "unknown spec"}`);
});

afterAll(() => {
	restore?.();
	restore = null;
});
