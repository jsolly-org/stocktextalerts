import { readEnv } from "../db/env";
import type { Logger } from "../logging";

/**
 * Validates the shared registration password from the signup form.
 * Returns an error key when validation fails, or null when the secret matches.
 */
export function checkRegistrationSecret(
	submitted: string,
	logger: Logger,
): "registration_unavailable" | "invalid_registration_password" | null {
	// readEnv (not requireEnv): missing secret is a user-facing unavailable state, not a boot failure.
	const expected = readEnv("REGISTRATION_SECRET_PASSWORD");
	if (!expected) {
		logger.error("Registration secret password is not configured", {
			action: "register",
		});
		return "registration_unavailable";
	}

	if (submitted.trim() !== expected.trim()) {
		logger.info("Registration rejected: invalid registration password", {
			action: "register",
		});
		return "invalid_registration_password";
	}

	return null;
}
