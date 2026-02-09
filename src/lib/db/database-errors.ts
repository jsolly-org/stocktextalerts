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
Database Limits
============= */

export const MAX_TRACKED_ASSETS = 10;

/* =============
Error Message Text
============= */

/*
 * Error message from replace_user_assets function (line 249 in migration).
 * Raised when user attempts to track more than MAX_TRACKED_ASSETS assets.
 */
const MESSAGE_ASSETS_LIMIT_EXCEEDED = "Tracked assets limit exceeded";

/*
 * Error message from replace_user_assets function.
 * Raised when an asset symbol contains whitespace.
 */
const MESSAGE_ASSETS_WHITESPACE = "Asset symbol contains whitespace";

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

export function isAssetsLimitError(error: unknown): boolean {
	if (!isPostgrestError(error)) {
		return false;
	}

	return (
		error.code === POSTGRES_RAISE_CODE &&
		error.message === MESSAGE_ASSETS_LIMIT_EXCEEDED
	);
}

export function isAssetsWhitespaceError(error: unknown): boolean {
	if (!isPostgrestError(error)) {
		return false;
	}

	return (
		error.code === POSTGRES_RAISE_CODE &&
		error.message === MESSAGE_ASSETS_WHITESPACE
	);
}
