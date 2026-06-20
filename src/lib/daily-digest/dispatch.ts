import { DateTime } from "luxon";
import { createSupabaseAdminClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { createEmailSender, type EmailSender } from "../messaging/email/utils";
import { loadPrefsByUser } from "../messaging/load-prefs";
import type { UserRecord } from "../messaging/types";
import type { ScheduledNotificationTotals, SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider, type SmsSenderProvider } from "../schedule/sms-sender";
import {
	createTelegramSenderProvider,
	type TelegramSenderProvider,
} from "../schedule/telegram-sender";
import type { MarketClosureInfo } from "../time/market-calendar";
import { processDailyDigestUser } from "./process";

type DailyDigestUserRow = Pick<
	UserRecord,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "use_24_hour_time"
	| "daily_digest_time"
	| "daily_digest_next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "asset_events_next_send_at"
	| "asset_events_last_analyst_sent_month"
	| "last_grok_rumors_at"
	| "grok_window_start"
	| "grok_sends_in_window"
	| "telegram_chat_id"
	| "telegram_opted_out"
	| "prefs"
>;

const EMPTY_STATS: ScheduledNotificationTotals = {
	skipped: 1,
	logFailures: 0,
	emailsSent: 0,
	emailsFailed: 0,
	smsSent: 0,
	smsFailed: 0,
	telegramSent: 0,
	telegramFailed: 0,
};

/** Process daily-digest for one user by calling processDailyDigestUser directly. */
export async function dispatchDailyDigestUser(options: {
	userId: string;
	currentTimeIso: string;
	/** When true, stage content instead of delivering. */
	precompute?: boolean;
	/** Pre-fetched market open status (avoids per-user API calls). */
	marketOpen?: boolean;
	/** Pre-fetched market closure info (avoids per-user API calls). */
	marketClosureInfo?: MarketClosureInfo | null;
	/** Shared scheduler client (avoids per-user Supabase construction). */
	supabase?: SupabaseAdminClient;
	/** Shared email sender from the cron run (reuses SES setup). */
	sendEmail?: EmailSender;
	/** Shared SMS provider from the cron run (reuses Twilio client cache). */
	getSmsSender?: SmsSenderProvider;
	/** Shared Telegram provider from the cron run (reuses bot/sender cache). */
	getTelegramSender?: TelegramSenderProvider;
}): Promise<ScheduledNotificationTotals> {
	const {
		userId,
		currentTimeIso,
		precompute,
		marketOpen,
		marketClosureInfo,
		supabase: supabaseOption,
		sendEmail: sendEmailOption,
		getSmsSender: getSmsSenderOption,
		getTelegramSender: getTelegramSenderOption,
	} = options;

	try {
		const currentTime = DateTime.fromISO(currentTimeIso, { zone: "utc" });
		if (!currentTime.isValid) {
			rootLogger.error("Invalid currentTimeIso for daily dispatch", {
				action: "dispatch_daily_user",
				userId,
				currentTimeIso,
			});
			return { ...EMPTY_STATS };
		}

		const supabase = supabaseOption ?? createSupabaseAdminClient();

		const { data: user, error: fetchError } = await supabase
			.from("users")
			.select(
				`
				id,
				email,
				phone_country_code,
				phone_number,
				phone_verified,
				timezone,
				use_24_hour_time,
				daily_digest_time,
				daily_digest_next_send_at,
				email_notifications_enabled,
				sms_notifications_enabled,
				sms_opted_out,
				asset_events_next_send_at,
				asset_events_last_analyst_sent_month,
				last_grok_rumors_at,
				grok_window_start,
				grok_sends_in_window,
				telegram_chat_id,
				telegram_opted_out
			`,
			)
			.eq("id", userId)
			.maybeSingle();

		if (fetchError) {
			rootLogger.error(
				"Failed to fetch user for daily dispatch",
				{ action: "dispatch_daily_user", userId },
				fetchError,
			);
			return { ...EMPTY_STATS };
		}

		if (!user) {
			rootLogger.error("User not found for daily dispatch", {
				action: "dispatch_daily_user",
				userId,
			});
			return { ...EMPTY_STATS };
		}

		const sendEmail = sendEmailOption ?? createEmailSender();
		const getSmsSender = getSmsSenderOption ?? createSmsSenderProvider();
		const getTelegramSender = getTelegramSenderOption ?? createTelegramSenderProvider();

		// Per-option preferences (all channels) live in notification_preferences.
		const prefsByUser = await loadPrefsByUser(supabase, [userId]);

		const dailyDigestUser: UserRecord = {
			...(user as Omit<DailyDigestUserRow, "prefs">),
			prefs: prefsByUser.get(userId) ?? [],
			// Not required for daily digest processing, but part of UserRecord.
			// Provide safe defaults rather than bypassing type checking via `unknown`.
			market_scheduled_asset_price_next_send_at: null,
			market_scheduled_asset_price_enabled: false,
			market_scheduled_asset_price_times: null,
		};

		return await processDailyDigestUser({
			user: dailyDigestUser,
			supabase,
			logger: rootLogger,
			currentTime,
			sendEmail,
			getSmsSender,
			getTelegramSender,
			stageOnly: precompute === true,
			marketOpen,
			marketClosureInfo,
		});
	} catch (error) {
		rootLogger.error(
			"Daily digest dispatch failed",
			{ action: "dispatch_daily_user", userId },
			error,
		);
		return { ...EMPTY_STATS };
	}
}
