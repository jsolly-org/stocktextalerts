/**
 * Runtime-mode helpers used by code shared between Astro SSR and AWS Lambda.
 *
 * Every runtime populates `process.env.NODE_ENV` at call time: Astro/Vite
 * sets it during dev + build, Vercel sets it in the SSR runtime, Vitest
 * (via `vitest.config.ts` + `tests/run-vitest.ts`) forces `test`, and the
 * SAM template sets `production` for each Lambda. `process.env.MODE` is a
 * belt-and-suspenders fallback for any runtime that skips NODE_ENV.
 */

export type RuntimeMode = "production" | "development" | "test";

export function currentMode(): RuntimeMode {
	const mode = process.env.NODE_ENV ?? process.env.MODE;
	if (mode === "production" || mode === "test") {
		return mode;
	}
	return "development";
}

export function isProduction(): boolean {
	return currentMode() === "production";
}

export function isTest(): boolean {
	return currentMode() === "test";
}
