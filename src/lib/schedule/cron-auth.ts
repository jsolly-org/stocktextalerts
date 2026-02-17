import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "../logging";

/**
 * Verifies that the supplied cron secret matches the expected CRON_SECRET env var.
 * Uses SHA256 + timing-safe comparison to prevent timing attacks.
 *
 * Returns the extracted secret string on success, or `null` on failure
 * (after logging the reason).
 */
/** Reject weak secrets (presence is already validated in middleware). */
function isAcceptableSecret(value: string | undefined): boolean {
	if (value == null || typeof value !== "string") return false;
	return value.trim().length >= 12;
}

export function verifyCronSecret(
	request: Request,
	logger: Logger,
): string | null {
	const authHeader = request.headers.get("authorization");
	const envCronSecret = import.meta.env.CRON_SECRET as string;

	if (!isAcceptableSecret(envCronSecret)) {
		logger.error("CRON_SECRET is too short (minimum 12 characters)", {
			action: "cron_auth",
		});
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

	const cronSecret = authHeader.split("Bearer ")[1];

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
