import { DateTime } from "luxon";
import {
	buildNewsContextForGrok,
	fetchFinnhubExtras,
	formatAnalystSection,
	formatInsiderSection,
} from "../finnhub-extras";
import { type GrokChannel, generateDailyExtrasWithGrok } from "../grok-extras";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { shouldSendSms } from "../messaging/sms";
import type { SmsExtras } from "../messaging/sms/delivery";
import type { UserRecord } from "../messaging/types";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { loadUserStocks } from "./helpers";
import {
	processDailyDigestEmailDelivery,
	processDailyDigestSmsDelivery,
} from "./run-user-daily-delivery";
import { updateUserDailyNextSendAt } from "./run-user-daily-next-send-at";
import type { SmsSenderProvider } from "./run-user-sms-sender";

const GROK_WINDOW_HOURS = 24;
const GROK_MAX_SENDS_PER_WINDOW = 10;

function canInvokeGrokWithinLimit(options: {
	grokWindowStart: string | null;
	grokSendsInWindow: number;
	currentTimeUtc: DateTime;
}): boolean {
	const { grokWindowStart, grokSendsInWindow, currentTimeUtc } = options;
	if (!grokWindowStart) {
		return true;
	}
	const windowStart = DateTime.fromISO(grokWindowStart, { zone: "utc" });
	if (!windowStart.isValid) {
		return true;
	}
	// If the window has expired, the counter will be reset — allow the send.
	if (currentTimeUtc.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS) {
		return true;
	}
	// Within the window — check the counter.
	return grokSendsInWindow < GROK_MAX_SENDS_PER_WINDOW;
}

export async function processDailyUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	marketOpen: boolean;
}): Promise<ScheduledNotificationTotals> {
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};
	const {
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		marketOpen,
	} = options;

	try {
		const dueAt = user.daily_next_send_at
			? DateTime.fromISO(user.daily_next_send_at, { zone: "utc" })
			: currentTime;
		if (!dueAt.isValid) {
			logger.error("Invalid daily_next_send_at timestamp", {
				userId: user.id,
				daily_next_send_at: user.daily_next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error("Failed to format local date for timezone (daily)", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error("Failed to format scheduled date (daily)", {
				userId: user.id,
				timezone: user.timezone,
				daily_next_send_at: user.daily_next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error("Failed to calculate scheduled minutes (daily)", {
				action: "daily_digest_run",
				userId: user.id,
				timezone: user.timezone,
				daily_next_send_at: user.daily_next_send_at,
				scheduledDate,
			});
			stats.skipped++;
			return stats;
		}

		if (user.daily_only_notify_when_market_open && !marketOpen) {
			logger.info("Skipping daily daily notification: market is closed", {
				action: "daily_digest_run",
				reason: "market_closed",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			await updateUserDailyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const hasAnyDailyOption =
			user.daily_include_news ||
			user.daily_include_rumors ||
			user.daily_include_analyst ||
			user.daily_include_insider;

		if (!hasAnyDailyOption) {
			stats.skipped++;
			await updateUserDailyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const userStocks = await loadUserStocks(supabase, user.id);
		const tickers = userStocks.map((s) => s.symbol);

		const needsGrok = user.daily_include_news || user.daily_include_rumors;
		const grokAllowed =
			needsGrok &&
			canInvokeGrokWithinLimit({
				grokWindowStart: user.grok_window_start,
				grokSendsInWindow: user.grok_sends_in_window,
				currentTimeUtc: currentTime,
			});

		if (needsGrok && !grokAllowed) {
			// Grok limit reached, but Finnhub-only daily can still proceed
			if (!user.daily_include_analyst && !user.daily_include_insider) {
				logger.info(
					"Skipping daily daily: Grok send limit reached for this window",
					{
						action: "daily_digest_run",
						reason: "grok_limit",
						userId: user.id,
						scheduledDate,
						scheduledMinutes,
						grokSendsInWindow: user.grok_sends_in_window,
					},
				);
				stats.skipped++;
				await updateUserDailyNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
				return stats;
			}
		}

		const emailEnabled = user.email_notifications_enabled;
		const smsEnabled = shouldSendSms(user);

		const channels: GrokChannel[] = [];
		if (emailEnabled) channels.push("email");
		if (smsEnabled) channels.push("sms");

		if (channels.length === 0) {
			stats.skipped++;
			await updateUserDailyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		/* =============
		Fetch Finnhub data (non-blocking — failures omit that section)
		============= */
		const finnhubData = await fetchFinnhubExtras(tickers, {
			includeNews: user.daily_include_news,
			includeAnalyst: user.daily_include_analyst,
			includeInsider: user.daily_include_insider,
		});

		// Build news context for Grok from Finnhub headlines
		const newsContext = user.daily_include_news
			? buildNewsContextForGrok(finnhubData.news)
			: undefined;

		const grokOptions = {
			tickers,
			localDateIso: scheduledDate,
			timezone: user.timezone,
			includeNews: user.daily_include_news,
			includeRumors: user.daily_include_rumors,
			finnhubNewsContext: newsContext || undefined,
		};

		const grokResultsByChannel = new Map<
			GrokChannel,
			{ news: string | null; rumors: string | null } | null
		>();

		if (grokAllowed) {
			const grokResults = await Promise.all(
				channels.map((channel) =>
					generateDailyExtrasWithGrok({ ...grokOptions, channel }),
				),
			);
			for (let i = 0; i < channels.length; i++) {
				grokResultsByChannel.set(channels[i], grokResults[i]);
			}
		}

		/* =============
		Format Finnhub-only sections (analyst + insider) per channel
		============= */
		function buildExtras(channel: GrokChannel): SmsExtras {
			const grok = grokResultsByChannel.get(channel);
			return {
				news: grok?.news ?? null,
				rumors: grok?.rumors ?? null,
				analyst: user.daily_include_analyst
					? formatAnalystSection(finnhubData.analyst, channel)
					: null,
				insider: user.daily_include_insider
					? formatInsiderSection(finnhubData.insider, channel)
					: null,
			};
		}

		const emailExtras = emailEnabled ? buildExtras("email") : null;
		const smsExtras = smsEnabled ? buildExtras("sms") : null;

		const hasEmailContent = !!(
			emailExtras?.news ||
			emailExtras?.rumors ||
			emailExtras?.analyst ||
			emailExtras?.insider
		);
		const hasSmsContent = !!(
			smsExtras?.news ||
			smsExtras?.rumors ||
			smsExtras?.analyst ||
			smsExtras?.insider
		);

		if (!hasEmailContent && !hasSmsContent) {
			logger.info("Skipping daily daily: no content available", {
				action: "daily_digest_run",
				reason: "no_content",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			await updateUserDailyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		if (hasEmailContent && emailExtras) {
			await processDailyDigestEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				extras: emailExtras,
				sendEmail,
				stats,
			});
		}

		if (hasSmsContent && smsExtras) {
			await processDailyDigestSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				extras: smsExtras,
				getSmsSender,
				stats,
			});
		}

		// Only bump the send counter if at least one delivery succeeded.
		// This way, if delivery fails (e.g. DB issue), the user can adjust
		// their time and get the notification re-sent without burning a send.
		if (stats.emailsSent > 0 || stats.smsSent > 0) {
			const now = currentTime.toISO();
			if (now) {
				// If the window has expired (or never started), reset the counter.
				const windowStart = user.grok_window_start
					? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
					: null;
				const windowExpired =
					!windowStart?.isValid ||
					currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

				const newCount = windowExpired ? 1 : user.grok_sends_in_window + 1;
				const newWindowStart = windowExpired ? now : user.grok_window_start;

				user.grok_sends_in_window = newCount;
				user.grok_window_start = newWindowStart;
				user.last_grok_rumors_at = now;

				const { error } = await supabase
					.from("users")
					.update({
						last_grok_rumors_at: now,
						grok_window_start: newWindowStart,
						grok_sends_in_window: newCount,
					})
					.eq("id", user.id);
				if (error) {
					logger.error(
						"Failed to update grok send counter (daily)",
						{ userId: user.id, newCount, newWindowStart },
						error,
					);
				}
			}
		}

		await updateUserDailyNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error(
			"Error processing daily daily user",
			{ userId: user.id },
			error,
		);
		/* =============
		Best-effort reschedule to avoid retry storms on persistent failures.
		============= */
		try {
			await updateUserDailyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} catch (updateError) {
			logger.error(
				"Failed to update daily_next_send_at after daily daily error",
				{ userId: user.id },
				updateError,
			);
		}
		return stats;
	}
}
