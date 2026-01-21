import type { PostgrestError } from "@supabase/supabase-js";

/* =============
Database Error Constants
============= */

/*
 * These constants represent error identifiers from database constraints and functions.
 *
 * We avoid string matching helpers like .includes() and instead check structured
 * Postgres error fields (code + exact message where applicable).
 */

/* =============
Constraint Names
============= */

/*
 * CHECK constraint on users table (line 182 in migration).
 * Raised when sms_notifications_enabled is true but phone is not set.
 */
export const CONSTRAINT_SMS_REQUIRES_PHONE = "users_sms_requires_phone";

/* =============
Database Limits
============= */

export const MAX_TRACKED_STOCKS = 50;

/* =============
Error Message Text
============= */

/*
 * Error message from replace_user_stocks function (line 249 in migration).
 * Raised when user attempts to track more than MAX_TRACKED_STOCKS stocks.
 */
export const MESSAGE_STOCKS_LIMIT_EXCEEDED = "Tracked stocks limit exceeded";

/*
 * Error message from update_user_preferences_and_stocks function (line 278 in migration).
 * Raised when tracked stocks array is null.
 */
export const MESSAGE_STOCKS_REQUIRED = "Tracked stocks required";

/*
 * Error message from replace_user_stocks function.
 * Raised when a stock symbol contains whitespace.
 */
export const MESSAGE_STOCKS_WHITESPACE = "Stock symbol contains whitespace";

const POSTGRES_RAISE_CODE = "P0001";

/* =============
Error Detection Helpers
============= */

type ErrorWithCode = { code: string | null; message: string };

function isPostgrestError(error: unknown): error is PostgrestError {
	if (!error || typeof error !== "object") {
		return false;
	}

	return (
		"code" in error &&
		"message" in error &&
		typeof (error as ErrorWithCode).message === "string" &&
		(typeof (error as ErrorWithCode).code === "string" ||
			(error as ErrorWithCode).code === null)
	);
}

export function isStocksLimitError(error: unknown): boolean {
	if (!isPostgrestError(error)) {
		return false;
	}

	return (
		error.code === POSTGRES_RAISE_CODE &&
		error.message === MESSAGE_STOCKS_LIMIT_EXCEEDED
	);
}

export function isStocksRequiredError(error: unknown): boolean {
	if (!isPostgrestError(error)) {
		return false;
	}

	return (
		error.code === POSTGRES_RAISE_CODE &&
		error.message === MESSAGE_STOCKS_REQUIRED
	);
}

export function isStocksWhitespaceError(error: unknown): boolean {
	if (!isPostgrestError(error)) {
		return false;
	}

	return (
		error.code === POSTGRES_RAISE_CODE &&
		error.message === MESSAGE_STOCKS_WHITESPACE
	);
}
