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
	const expected = readEnv("REGISTRATION_SECRET_PASSWORD");
	if (!expected) {
		logger.error("Registration secret password is not configured", {
			action: "register",
		});
		return "registration_unavailable";
	}

	if (submitted.trim() !== expected) {
		logger.info("Registration rejected: invalid registration password");
		return "invalid_registration_password";
	}

	return null;
}
