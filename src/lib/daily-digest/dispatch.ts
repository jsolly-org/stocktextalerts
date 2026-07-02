import { DateTime } from "luxon";
import { fetchOneDailyNotificationUser } from "../daily-notification/query";
import type { SupabaseAdminClient } from "../db/supabase";
import { createSupabaseAdminClient } from "../db/supabase";
import { rootLogger } from "../logging";
import type { LogoCache } from "../messaging/logo-fetcher";
import { createNotificationSenders } from "../messaging/senders";
import type { SmsSenderFactory } from "../messaging/sms/sender-factory";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender } from "../messaging/types";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import type { MarketClosureInfo } from "../time/types";
import type { UserRecord } from "../types";
import { processDailyDigestUser } from "./process";

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
	/** Pre-fetched UserRecord (with prefs) from the scheduler — when provided, skip the
	 *  per-user fetch + prefs load. Absent only on the standalone-invoke path. */
	user?: UserRecord;
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
	getSmsSender?: SmsSenderFactory;
	/** Shared Telegram provider from the cron run (reuses bot/sender cache). */
	getTelegramSender?: TelegramSenderFactory;
	/** Shared per-pass logo cache so a symbol's logo is resolved once per pass, not per user. */
	logoCache?: LogoCache;
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
		const senders = createNotificationSenders();
		const sendEmail = sendEmailOption ?? senders.sendEmail;
		const getSmsSender = getSmsSenderOption ?? senders.getSmsSender;
		const getTelegramSender = getTelegramSenderOption ?? senders.getTelegramSender;

		// Reuse the UserRecord (with prefs) the scheduler already loaded when provided;
		// only fall back to a per-user fetch on the standalone-invoke path, via the same
		// canonical select the batch fetch uses (no hand-maintained second column list).
		let dailyDigestUser = options.user;
		if (!dailyDigestUser) {
			const fetched = await fetchOneDailyNotificationUser(supabase, userId);
			if (!fetched) {
				rootLogger.error("User not found for daily dispatch", {
					action: "dispatch_daily_user",
					userId,
				});
				return { ...EMPTY_STATS };
			}
			dailyDigestUser = fetched;
		}

		const user = dailyDigestUser;
		return await processDailyDigestUser({
			user,
			supabase,
			logger: rootLogger,
			currentTime,
			sendEmail,
			getSmsSender,
			getTelegramSender,
			stageOnly: precompute === true,
			marketOpen,
			marketClosureInfo,
			logoCache: options.logoCache,
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
