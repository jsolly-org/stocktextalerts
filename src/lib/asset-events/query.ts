import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Fetch users eligible for a standalone asset events run.
 *
 * Only picks up users who have asset events enabled but are NOT handled by
 * the daily pipeline (i.e., they don't have daily_digest_time set with daily features enabled).
 */
export async function fetchAssetEventsUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		let query = options.supabase
			.from("users")
			.select(
				`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			timezone,
			daily_digest_time,
			daily_digest_include_news_email,
			daily_digest_include_rumors_email,
			asset_events_include_earnings_email,
			asset_events_include_earnings_sms,
			asset_events_include_dividends_email,
			asset_events_include_dividends_sms,
			asset_events_include_splits_email,
			asset_events_include_splits_sms,
			asset_events_include_analyst_email,
			asset_events_include_analyst_sms,
			asset_events_include_insider_email,
			asset_events_include_insider_sms,
			asset_events_next_send_at,
			asset_events_last_analyst_sent_month,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out
		`,
			)
			.or(
				"asset_events_include_earnings_email.eq.true,asset_events_include_earnings_sms.eq.true,asset_events_include_dividends_email.eq.true,asset_events_include_dividends_sms.eq.true,asset_events_include_splits_email.eq.true,asset_events_include_splits_sms.eq.true,asset_events_include_analyst_email.eq.true,asset_events_include_analyst_sms.eq.true,asset_events_include_insider_email.eq.true,asset_events_include_insider_sms.eq.true",
			)
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			);

		if (!options.forceSend) {
			query = query
				.not("asset_events_next_send_at", "is", null)
				.lte("asset_events_next_send_at", options.currentTimeIso);
		}

		const { data, error } = await query;
		if (!error) {
			// Filter out users handled by the daily pipeline (they have daily_digest_time AND daily features)
			const filtered = ((data ?? []) as unknown as UserRecord[]).filter(
				(user) =>
					!(
						user.daily_digest_time != null &&
						(user.daily_digest_include_news_email ||
							user.daily_digest_include_rumors_email)
					),
			);
			return filtered;
		}

		if (attempt === MAX_RETRIES) {
			options.logger.error("Failed to fetch asset events users after retries", {
				attempts: MAX_RETRIES + 1,
				errorMessage: error.message.slice(0, 200),
			});
			throw new Error(
				`Failed to fetch asset events users after ${MAX_RETRIES + 1} attempts`,
			);
		}

		options.logger.warn(
			"Transient error fetching asset events users, retrying",
			{
				attempt: attempt + 1,
				maxRetries: MAX_RETRIES,
				errorMessage: error.message.slice(0, 200),
			},
		);
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	}

	throw new Error("Failed to fetch asset events users: retries exhausted");
}
