import type { Logger } from "../logging";
import type { SupabaseAdminClient } from "../schedule/helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Execute a users-table query with retries on transient errors.
 * Reduces duplication across asset-events, daily-digest, and market-scheduled query modules.
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
