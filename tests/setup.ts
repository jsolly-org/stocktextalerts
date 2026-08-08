import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { getRealAssetSymbols } from "./helpers/asset-data";
import { resetTestEnvStubs, restoreBaselineTestEnvStubs } from "./helpers/env-stubs";
import { cleanupTestUser } from "./helpers/test-user";
import { takeTestUserIdsForCleanup } from "./helpers/test-user-cleanup";

vi.mock("../src/lib/db/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/db/env")>();
	return {
		...actual,
		getSiteUrl: () => "http://localhost",
		getValidatedUnsubscribeTokenSecret: () => {
			const fromProcess = process.env.UNSUBSCRIBE_TOKEN_SECRET;
			if (typeof fromProcess !== "string" || fromProcess.trim().length < 12) {
				return null;
			}
			return fromProcess;
		},
	};
});

vi.mock("../src/lib/messaging/email/dispatch-client", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/lib/messaging/email/dispatch-client")>();
	const { createTestEmailSender } = await import("./helpers/messaging-doubles");
	const testSend = createTestEmailSender();
	return {
		...actual,
		sendAppTransactionalEmail: async (
			request: Parameters<typeof actual.sendAppTransactionalEmail>[0],
			logger: Parameters<typeof actual.sendAppTransactionalEmail>[1],
		) => {
			const dispatchUrl = process.env.EMAIL_DISPATCH_URL?.trim();
			if (dispatchUrl) {
				return actual.sendAppTransactionalEmail(request, logger);
			}
			return testSend(request);
		},
	};
});

vi.mock("../src/lib/messaging/email/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/messaging/email/utils")>();
	const { createTestEmailSender } = await import("./helpers/messaging-doubles");
	return {
		...actual,
		createEmailSender: () => {
			const smtpHost = process.env.EMAIL_SMTP_HOST;
			if (typeof smtpHost === "string" && smtpHost.trim().length > 0) {
				return actual.createEmailSender();
			}
			return createTestEmailSender();
		},
	};
});

vi.mock("../src/lib/messaging/telegram/sender", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/messaging/telegram/sender")>();
	const { createTestTelegramSender } = await import("./helpers/messaging-doubles");
	return {
		...actual,
		createTelegramSender: (_bot: unknown) => createTestTelegramSender(),
	};
});

vi.mock("../src/lib/market-data/session", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/market-data/session")>();
	const { testGetCurrentMarketSession } = await import("./helpers/price-fetcher-doubles");
	return {
		...actual,
		getCurrentMarketSession: testGetCurrentMarketSession,
	};
});

vi.mock("../src/lib/market-data/sparklines", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/market-data/sparklines")>();
	const { testFetchIntradaySparklines, testFetchSparklines } = await import(
		"./helpers/price-fetcher-doubles"
	);
	return {
		...actual,
		fetchSparklines: testFetchSparklines,
		fetchIntradaySparklines: testFetchIntradaySparklines,
	};
});

// Live provider keys exist only in the Lambda runtime (SAM params). Locally
// they are always stubbed — the real providers are exercised in production by
// the scheduled `live-provider-check` Lambda (src/handlers/maintenance/live-provider-check.ts),
// not by the local test suite.
//
// Outbound email/Telegram and default market-data session/sparkline
// stubs are wired via vi.mock above (tests/helpers/*-doubles.ts). Tests that
// need the real factory can vi.importActual or override the mock per file.
// Data-provider stubs set a dummy API key so requireEnv() doesn't throw.
// Actual HTTP calls are prevented by fetch mocks or module-level mocks in
// individual test files.
restoreBaselineTestEnvStubs();

afterEach(async () => {
	const userIds = takeTestUserIdsForCleanup();
	for (const userId of userIds) {
		await cleanupTestUser(userId);
	}
	resetTestEnvStubs();
});

export const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
export const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

type ConsolePattern = string | RegExp;
let expectedErrors: ConsolePattern[] = [];

export function expectConsoleError(pattern: ConsolePattern) {
	expectedErrors.push(pattern);
}

export function resetConsoleAssertions() {
	expectedErrors = [];
}

function extractLogMessage(raw: unknown): string {
	if (typeof raw !== "string") return String(raw);
	try {
		return (JSON.parse(raw) as { message?: string }).message ?? raw;
	} catch {
		return raw;
	}
}

/** Parse the JSON log lines captured by a console spy down to their `message` fields. */
export function loggedMessages(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls.map((call) => extractLogMessage(call[0]));
}

/** The captured `console.warn` messages (structured-log `message` fields). */
export function warnMessages(): string[] {
	return loggedMessages(warnSpy);
}

/** The captured `console.error` messages (structured-log `message` fields). */
export function errorMessages(): string[] {
	return loggedMessages(errorSpy);
}

function matchesPattern(message: string, pattern: ConsolePattern): boolean {
	if (typeof pattern === "string") return message === pattern;
	return pattern.test(message);
}

// Mirror production's failure model: `warn` is informational (transient retries,
// degraded-but-handled paths) and never pages, so it never fails a test either.
// warnSpy stays available for tests that positively assert a specific warning was
// logged. An unexpected `console.error` still fails — in prod an error is the
// pageable signal, and a test must surface the same. Allow expected errors via
// expectConsoleError().
afterEach(() => {
	try {
		if (expectedErrors.length === 0) {
			expect(errorSpy.mock.calls, "Unexpected console.error").toEqual([]);
		} else {
			for (const call of errorSpy.mock.calls) {
				const message = extractLogMessage(call[0]);
				const matched = expectedErrors.some((p) => matchesPattern(message, p));
				expect(matched, `Unexpected console.error: ${message}`).toBe(true);
			}
		}
	} finally {
		warnSpy.mockClear();
		errorSpy.mockClear();
		resetConsoleAssertions();
	}
});

// The HTTP test dev server is deliberately NOT stopped here. This hook runs once per
// test file, so tearing the server down in it killed the server other files were still
// using as soon as file parallelism was turned on. Its lifecycle belongs to the run:
// tests/global-setup.ts owns the teardown.
afterAll(() => {
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

// Schema/admin verification and the run-wide user wipe live in tests/global-setup.ts: they
// answer questions that cannot change mid-run, and the wipe is actively unsafe once files
// run in parallel, because it deletes users other workers are still asserting on. What is
// left here is per-worker state: the asset cache lives in worker memory, so every worker
// still primes it once.
beforeAll(async () => {
	getRealAssetSymbols(1);
});
