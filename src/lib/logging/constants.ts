export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Require separators or a country code to reduce false positives (may miss bare digits).
// Matches: +1 (415) 555-1234, (415) 555-1234, 415-555-1234, etc.
export const PHONE_CANDIDATE_RE = /(?:\+\d{1,3}[\s().-]*)?\(?\d{3}\)?[\s().-]*\d{3}[\s().-]*\d{4}/g;

/** Context keys that indicate secrets; always redact to avoid leaking credentials. */
export const SENSITIVE_KEY_PATTERNS = [
	"secret",
	"password",
	"apikey",
	"api_key",
	"credential",
	"authtoken",
	"auth_token",
	"access_token",
	"refresh_token",
	"authorization",
];
