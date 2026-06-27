/**
 * Process-level env normalization for Vitest. Safe to import from vitest.config.ts
 * (no vitest/vi dependency).
 */
export function normalizeDirectVitestProcessEnv(): void {
	process.env.NODE_ENV = "test";
	// Strip even when set in `.env.local` — real SMTP + fake timers deadlock (see run-vitest.ts).
	process.env.EMAIL_SMTP_HOST = "";
	// E2E/build sets this for dummy API keys; unit tests mock fetch instead.
	delete process.env.SKIP_VENDOR_HTTP_IN_TEST;
}
