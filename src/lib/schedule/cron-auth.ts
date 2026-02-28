import { createHash, timingSafeEqual } from "node:crypto";
import { getCronSecret } from "../db/env";
import type { Logger } from "../logging";

/**
 * Verifies that the supplied cron secret matches the expected CRON_SECRET env var.
 * Uses SHA256 + timing-safe comparison to prevent timing attacks.
 *
 * Returns the extracted secret string on success, or `null` on failure
 * (after logging the reason).
 */
/** Reject weak or missing secrets; defensively handles absent env var for graceful failure. */
function isAcceptableSecret(value: string | undefined): value is string {
	if (value == null || typeof value !== "string") return false;
	return value.trim().length >= 12;
}

export function verifyCronSecret(
	request: Request,
	logger: Logger,
): string | null {
	const authHeader = request.headers.get("authorization");
	const envCronSecret = getCronSecret();

	if (!isAcceptableSecret(envCronSecret)) {
		logger.error(
			"CRON_SECRET is missing or too short (minimum 12 characters)",
			{
				action: "cron_auth",
			},
		);
		return null;
	}

	if (!authHeader) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "missing_authorization_header",
		});
		return null;
	}

	if (!authHeader.startsWith("Bearer ")) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "malformed_authorization_header",
		});
		return null;
	}

	const cronSecret = authHeader.slice(7); // "Bearer " is 7 chars
	if (!cronSecret || cronSecret.trim().length === 0) {
		logger.info("Unauthorized cron request", {
			action: "cron_auth",
			reason: "empty_bearer_token",
		});
		return null;
	}

	try {
		const suppliedSecret = createHash("sha256").update(cronSecret).digest();
		const expectedSecret = createHash("sha256").update(envCronSecret).digest();
		const authorized = timingSafeEqual(suppliedSecret, expectedSecret);

		if (!authorized) {
			logger.info("Unauthorized cron request", {
				action: "cron_auth",
				reason: "cron_secret_mismatch",
			});
			return null;
		}

		return cronSecret;
	} catch (error) {
		logger.error(
			"Failed to compare cron secrets securely",
			{ action: "compare_cron_secret" },
			error,
		);
		return null;
	}
}
