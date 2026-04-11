import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import { errorSpy, expectConsoleError } from "../../setup";

describe("Structured errors from library clients are logged readably.", () => {
	beforeEach(() => {
		vi.stubEnv("LOG_MASK_PII", "false");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("A Supabase PostgrestError flowing through the retry helper surfaces its message and preserves code/hint/details in raw.", () => {
		expectConsoleError(/Failed to fetch/);
		errorSpy.mockClear();

		const postgrestError = {
			message: "canceling statement due to statement timeout",
			code: "57014",
			details: null,
			hint: "Check pooler connection limits",
		};

		rootLogger.error(
			"Failed to fetch daily users after retries",
			{ attempts: 3 },
			postgrestError,
		);

		const [raw] = errorSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.error.message).toBe(
			"canceling statement due to statement timeout",
		);
		expect(payload.error.raw).toEqual(postgrestError);
		expect(payload.context.attempts).toBe(3);
	});

	it("A sensitive-named field nested inside an error object is redacted even with PII masking disabled.", () => {
		expectConsoleError(/Upstream auth call failed/);
		errorSpy.mockClear();

		const upstreamError = {
			message: "401 Unauthorized",
			access_token: "eyJhbGciOiJIUzI1NiJ9.leaked",
			requestId: "req-abc-123",
		};

		rootLogger.error(
			"Upstream auth call failed",
			{ userId: "u_1" },
			upstreamError,
		);

		const [raw] = errorSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.error.raw.access_token).toBe("[REDACTED]");
		expect(payload.error.raw.requestId).toBe("req-abc-123");
		expect(payload.error.message).toBe("401 Unauthorized");
	});

	it("A non-Error primitive still falls through to the 'Non-Error thrown' catch-all.", () => {
		expectConsoleError(/Unexpected throw/);
		errorSpy.mockClear();

		rootLogger.error("Unexpected throw", { source: "legacy-path" }, 42);

		const [raw] = errorSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.error.message).toBe("Non-Error thrown");
		expect(payload.error.raw).toBe(42);
	});
});
