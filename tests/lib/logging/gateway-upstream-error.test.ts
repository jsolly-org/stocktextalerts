import { describe, expect, it, vi } from "vitest";
import {
	isGatewayOrTransientUpstreamError,
	logHousekeepingPurgeFailure,
	summarizeErrorMessageForLog,
} from "../../../src/lib/logging/errors";

const HTML_520 = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head><title>example.com | 520: Web server is returning an unknown error</title></head>
<body>
<span class="code-label">Error code 520</span>
<p>${"x".repeat(400)}</p>
</body>
</html>`;

describe("isGatewayOrTransientUpstreamError", () => {
	it("treats a plaintext Internal server error with no PostgREST code as a gateway blip", () => {
		expect(isGatewayOrTransientUpstreamError({ message: "Internal server error." })).toBe(true);
		expect(isGatewayOrTransientUpstreamError(new Error("Internal server error"))).toBe(true);
	});

	it("treats summarized HTML CDN pages and Envoy connect-refused copy as gateway blips", () => {
		expect(isGatewayOrTransientUpstreamError({ message: HTML_520 })).toBe(true);
		expect(
			isGatewayOrTransientUpstreamError({
				message: "upstream connect error or disconnect/reset before headers",
			}),
		).toBe(true);
		expect(summarizeErrorMessageForLog(HTML_520)).toBe("Upstream HTML error response (HTTP 520)");
		expect(
			isGatewayOrTransientUpstreamError({
				message: "Upstream HTML error response (HTTP 520)",
			}),
		).toBe(true);
	});

	it("keeps structured Postgres and PostgREST failures pageable even when the message looks generic", () => {
		expect(
			isGatewayOrTransientUpstreamError({
				message: "Internal server error.",
				code: "57014",
			}),
		).toBe(false);
		expect(
			isGatewayOrTransientUpstreamError({
				message: "canceling statement due to statement timeout",
				code: "57014",
			}),
		).toBe(false);
		expect(
			isGatewayOrTransientUpstreamError({
				message: HTML_520,
				code: "PGRST301",
			}),
		).toBe(false);
	});

	it("does not classify unrelated messages as gateway blips", () => {
		expect(isGatewayOrTransientUpstreamError({ message: "permission denied for table" })).toBe(
			false,
		);
		expect(isGatewayOrTransientUpstreamError({ message: "boom" })).toBe(false);
	});
});

describe("logHousekeepingPurgeFailure", () => {
	it("warns for gateway-shaped failures and errors when a PostgREST/SQLSTATE code is present", () => {
		const logger = { warn: vi.fn(), error: vi.fn() };
		const genericGateway = { message: "Internal server error." };
		const htmlGateway = { message: HTML_520 };
		const envoyGateway = {
			message: "upstream connect error or disconnect/reset before headers",
		};
		const codedGeneric = {
			message: "Internal server error.",
			code: "57014",
		};
		const timeout = {
			message: "canceling statement due to statement timeout",
			code: "57014",
		};
		const ctx = { action: "purge_email_dispatch_keys" };

		logHousekeepingPurgeFailure(
			logger,
			"Failed to purge expired email-dispatch keys",
			ctx,
			genericGateway,
		);
		logHousekeepingPurgeFailure(
			logger,
			"Failed to purge expired email-dispatch keys",
			ctx,
			htmlGateway,
		);
		logHousekeepingPurgeFailure(
			logger,
			"Failed to purge expired email-dispatch keys",
			ctx,
			envoyGateway,
		);
		logHousekeepingPurgeFailure(
			logger,
			"Failed to purge expired email-dispatch keys",
			ctx,
			codedGeneric,
		);
		logHousekeepingPurgeFailure(
			logger,
			"Failed to purge expired email-dispatch keys",
			ctx,
			timeout,
		);

		expect(logger.warn).toHaveBeenCalledTimes(3);
		expect(logger.warn).toHaveBeenCalledWith(
			"Failed to purge expired email-dispatch keys",
			ctx,
			genericGateway,
		);
		expect(logger.warn).toHaveBeenCalledWith(
			"Failed to purge expired email-dispatch keys",
			ctx,
			htmlGateway,
		);
		expect(logger.warn).toHaveBeenCalledWith(
			"Failed to purge expired email-dispatch keys",
			ctx,
			envoyGateway,
		);
		expect(logger.error).toHaveBeenCalledTimes(2);
		expect(logger.error).toHaveBeenCalledWith(
			"Failed to purge expired email-dispatch keys",
			ctx,
			codedGeneric,
		);
		expect(logger.error).toHaveBeenCalledWith(
			"Failed to purge expired email-dispatch keys",
			ctx,
			timeout,
		);
	});
});
