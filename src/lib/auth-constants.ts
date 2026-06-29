/** Set to true to allow new account registrations. */
export const REGISTRATION_ENABLED = true;

/** Minimum password length enforced at the application level. */
export const MIN_PASSWORD_LENGTH = 8;

const VERIFICATION_EXPIRATION_MINUTES = 10;
/** Verification code lifetime in milliseconds. */
export const VERIFICATION_EXPIRATION_MS = VERIFICATION_EXPIRATION_MINUTES * 60 * 1000;

const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;
/** Minimum time between verification-code sends (milliseconds). */
export const VERIFICATION_RESEND_COOLDOWN_MS = VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000;
