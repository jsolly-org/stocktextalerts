import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import { errorSpy, expectConsoleError, expectConsoleWarning, warnSpy } from "../../setup";

describe("Sensitive user data is masked in logs.", () => {
	let infoSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		infoSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it("When masking is enabled, email and phone are redacted in info logs.", () => {
		vi.stubEnv("LOG_MASK_PII", "true");

		rootLogger.info("Contact test@example.com", { phone: "+1 (415) 555-1234" });

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("When masking is enabled, email and phone are redacted in warning logs.", () => {
		vi.stubEnv("LOG_MASK_PII", "true");
		expectConsoleWarning(/^Contact/);
		warnSpy.mockClear();

		rootLogger.warn("Contact test@example.com", { phone: "+1 (415) 555-1234" });

		const [raw] = warnSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("When masking is enabled, email and phone are redacted in error logs.", () => {
		vi.stubEnv("LOG_MASK_PII", "true");
		expectConsoleError(/^Contact/);
		errorSpy.mockClear();

		rootLogger.error("Contact test@example.com", {
			phone: "+1 (415) 555-1234",
		});

		const [raw] = errorSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("When masking is disabled, email and phone are logged as provided.", () => {
		vi.stubEnv("LOG_MASK_PII", "false");

		rootLogger.info("Email test@example.com", { phone: "415-555-1234" });

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Email test@example.com");
		expect(payload.context.phone).toBe("415-555-1234");
	});

	it("When masking is not configured, email and phone are redacted by default.", () => {
		vi.stubEnv("LOG_MASK_PII", "");

		rootLogger.info("Contact test@example.com", { phone: "+1 (415) 555-1234" });

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("A service logs auth context and secret-like keys are redacted even when PII masking is disabled.", () => {
		vi.stubEnv("LOG_MASK_PII", "false");

		rootLogger.info("Auth attempt", {
			password: "secret123",
			cronSecret: "bearer-token-value",
			authToken: "twilio-token",
			requestId: "req-1",
		});

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.requestId).toBe("req-1");
		expect(payload.context.password).toBe("[REDACTED]");
		expect(payload.context.cronSecret).toBe("[REDACTED]");
		expect(payload.context.authToken).toBe("[REDACTED]");
	});
});
