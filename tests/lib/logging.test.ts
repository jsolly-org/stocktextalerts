import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../src/lib/logging";
import {
	allowConsoleErrors,
	allowConsoleWarnings,
	errorSpy,
	warnSpy,
} from "../setup";

describe("logging PII masking", () => {
	let infoSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		infoSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it("masks email and phone when LOG_MASK_PII is enabled", () => {
		vi.stubEnv("LOG_MASK_PII", "true");

		rootLogger.info("Contact test@example.com", { phone: "+1 (415) 555-1234" });

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("masks email and phone in warnings when LOG_MASK_PII is enabled", () => {
		vi.stubEnv("LOG_MASK_PII", "true");
		allowConsoleWarnings();
		warnSpy.mockClear();

		rootLogger.warn("Contact test@example.com", { phone: "+1 (415) 555-1234" });

		const [raw] = warnSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("masks email and phone in errors when LOG_MASK_PII is enabled", () => {
		vi.stubEnv("LOG_MASK_PII", "true");
		allowConsoleErrors();
		errorSpy.mockClear();

		rootLogger.error("Contact test@example.com", {
			phone: "+1 (415) 555-1234",
		});

		const [raw] = errorSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});

	it("leaves PII unchanged when LOG_MASK_PII is false", () => {
		vi.stubEnv("LOG_MASK_PII", "false");

		rootLogger.info("Email test@example.com", { phone: "415-555-1234" });

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Email test@example.com");
		expect(payload.context.phone).toBe("415-555-1234");
	});

	it("masks PII by default when LOG_MASK_PII is not set", () => {
		vi.stubEnv("LOG_MASK_PII", "");

		rootLogger.info("Contact test@example.com", { phone: "+1 (415) 555-1234" });

		const [raw] = infoSpy.mock.calls[0];
		const payload = JSON.parse(raw as string);

		expect(payload.message).toBe("Contact [REDACTED]");
		expect(payload.context.phone).toBe("[REDACTED]");
	});
});
