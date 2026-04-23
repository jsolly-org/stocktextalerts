/**
 * Runtime-mode helpers used by code shared between Astro SSR and AWS Lambda.
 *
 * Both runtimes populate `process.env.NODE_ENV`: Astro/Vite sets it at build
 * time, Vercel sets it at runtime, Vitest sets `test`, and the SAM template
 * sets `production` for each Lambda. `process.env.MODE` is checked as a
 * fallback because Vitest mirrors its `import.meta.env.MODE` value there.
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
