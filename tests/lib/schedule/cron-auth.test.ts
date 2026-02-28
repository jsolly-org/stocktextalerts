import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCronSecret } from "../../../src/lib/schedule/cron-auth";

function createLoggerMock() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

describe("Cron secret verification protects scheduled endpoints.", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("Accepts a correctly signed Bearer token.", () => {
		vi.stubEnv("CRON_SECRET", "long-enough-secret");
		const logger = createLoggerMock();

		const request = new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: {
				authorization: "Bearer long-enough-secret",
			},
		});

		const result = verifyCronSecret(request, logger);

		expect(result).toBe("long-enough-secret");
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("Rejects missing authorization headers.", () => {
		vi.stubEnv("CRON_SECRET", "long-enough-secret");
		const logger = createLoggerMock();

		const request = new Request("http://localhost/api/schedule", {
			method: "POST",
		});

		const result = verifyCronSecret(request, logger);

		expect(result).toBeNull();
		expect(logger.info).toHaveBeenCalledWith(
			"Unauthorized cron request",
			expect.objectContaining({ reason: "missing_authorization_header" }),
		);
	});

	it("Rejects malformed authorization headers.", () => {
		vi.stubEnv("CRON_SECRET", "long-enough-secret");
		const logger = createLoggerMock();

		const request = new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: {
				authorization: "Token long-enough-secret",
			},
		});

		const result = verifyCronSecret(request, logger);

		expect(result).toBeNull();
		expect(logger.info).toHaveBeenCalledWith(
			"Unauthorized cron request",
			expect.objectContaining({ reason: "malformed_authorization_header" }),
		);
	});

	it("Rejects empty Bearer token.", () => {
		vi.stubEnv("CRON_SECRET", "long-enough-secret");
		const logger = createLoggerMock();

		const request = new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: {
				authorization: "Bearer ",
			},
		});

		const result = verifyCronSecret(request, logger);

		expect(result).toBeNull();
		expect(logger.info).toHaveBeenCalledWith(
			"Unauthorized cron request",
			expect.objectContaining({ reason: "empty_bearer_token" }),
		);
	});

	it("Rejects incorrect secrets even with Bearer formatting.", () => {
		vi.stubEnv("CRON_SECRET", "long-enough-secret");
		const logger = createLoggerMock();

		const request = new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: {
				authorization: "Bearer wrong-secret",
			},
		});

		const result = verifyCronSecret(request, logger);

		expect(result).toBeNull();
		expect(logger.info).toHaveBeenCalledWith(
			"Unauthorized cron request",
			expect.objectContaining({ reason: "cron_secret_mismatch" }),
		);
	});

	it("Rejects weak or missing CRON_SECRET environment configuration.", () => {
		vi.stubEnv("CRON_SECRET", "short");
		const logger = createLoggerMock();

		const request = new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: {
				authorization: "Bearer short",
			},
		});

		const result = verifyCronSecret(request, logger);

		expect(result).toBeNull();
		expect(logger.error).toHaveBeenCalledWith(
			"CRON_SECRET does not meet policy (minimum 12 characters)",
			expect.objectContaining({ action: "cron_auth" }),
		);
	});
});
