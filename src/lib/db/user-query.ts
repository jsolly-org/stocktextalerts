import type { Logger } from "../logging";
import type { SupabaseAdminClient } from "../schedule/helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Execute a users-table query with retries on transient errors.
 *
 * Runs `execute` up to 3 times (initial + 2 retries). On success, returns the data array
 * (or empty array if null). On each transient error, logs a warning, waits 1 second, and retries.
 * Throws after all retries are exhausted.
 *
 * Reduces duplication across asset-events, daily-digest, and market-scheduled query modules.
 *
 * @param options.supabase - Supabase admin client for database access
 * @param options.logger - Logger for error/warn messages
 * @param options.label - Label for log messages (e.g. "scheduled users")
 * @param options.execute - Async function returning `{ data, error }` from a Supabase query
 * @returns Array of typed user records on success
 */
export async function fetchUsersWithRetry<T>(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	label: string;
	execute: () => Promise<{ data: T[] | null; error: unknown }>;
}): Promise<T[]> {
	const { logger, label, execute } = options;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const { data, error } = await execute();

		if (!error) {
			return (data ?? []) as T[];
		}

		const errorMessage =
			error instanceof Error ? error.message.slice(0, 200) : String(error);

		if (attempt === MAX_RETRIES) {
			logger.error(`Failed to fetch ${label} after retries`, {
				attempts: MAX_RETRIES + 1,
				errorMessage,
			});
			throw new Error(
				`Failed to fetch ${label} after ${MAX_RETRIES + 1} attempts`,
			);
		}

		logger.warn(`Transient error fetching ${label}, retrying`, {
			attempt: attempt + 1,
			maxRetries: MAX_RETRIES,
			errorMessage,
		});
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	}

	throw new Error(`Failed to fetch ${label}: retries exhausted`);
}
