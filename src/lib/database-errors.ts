/* =============
Database Error Constants
============= */

/*
 * These constants represent error identifiers from database constraints and functions.
 *
 * In Postgres, errors raised by table constraints (e.g. CHECK/UNIQUE) reliably include the
 * constraint name, but the message text is generic ("violates check constraint ...") and
 * not something we control.
 *
 * Errors raised via `RAISE EXCEPTION '...' USING CONSTRAINT = '...'` include both a stable
 * constraint name and a custom message string that we do control.
 *
 * When the database raises these errors, Supabase/PostgREST includes the constraint
 * name or message text in the error.message property. We match against these strings
 * to determine the specific error type for proper user-facing error handling.
 */

/* =============
Constraint Names
============= */

/*
 * CHECK constraint on users table (line 182 in migration).
 * Raised when sms_notifications_enabled is true but phone is not set.
 */
export const CONSTRAINT_SMS_REQUIRES_PHONE = "users_sms_requires_phone";

/*
 * Constraint name from RAISE EXCEPTION in replace_user_stocks function (line 251).
 * Raised when user attempts to track more than 50 stocks.
 */
export const CONSTRAINT_STOCKS_MAX_LIMIT = "user_stocks_max_limit";

/*
 * Constraint name from RAISE EXCEPTION in update_user_preferences_and_stocks function (line 280).
 * Raised when tracked stocks array is null.
 */
export const CONSTRAINT_STOCKS_REQUIRED = "user_stocks_required";

/* =============
Error Message Text
============= */

/*
 * Error message from replace_user_stocks function (line 249 in migration).
 * Raised when user attempts to track more than 50 stocks.
 */
export const MESSAGE_STOCKS_LIMIT_EXCEEDED = "Tracked stocks limit exceeded";

/*
 * Error message from update_user_preferences_and_stocks function (line 278 in migration).
 * Raised when tracked stocks array is null.
 */
export const MESSAGE_STOCKS_REQUIRED = "Tracked stocks required";

/* =============
Error Detection Helpers
============= */

export function isSmsRequiresPhoneError(errorMessage: string): boolean {
	// This is a plain CHECK constraint, so the only stable identifier is the constraint name.
	return errorMessage.includes(CONSTRAINT_SMS_REQUIRES_PHONE);
}

export function isStocksLimitError(errorMessage: string): boolean {
	return (
		errorMessage.includes(CONSTRAINT_STOCKS_MAX_LIMIT) ||
		errorMessage.includes(MESSAGE_STOCKS_LIMIT_EXCEEDED)
	);
}

export function isStocksRequiredError(errorMessage: string): boolean {
	return (
		errorMessage.includes(CONSTRAINT_STOCKS_REQUIRED) ||
		errorMessage.includes(MESSAGE_STOCKS_REQUIRED)
	);
}
