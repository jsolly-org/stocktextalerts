import { DateTime } from "luxon";
import type { Database } from "../db/generated/database.types";
import { generateFirstNotificationExtrasWithGrok } from "../grok/extras";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { shouldSendSms } from "../messaging/sms";
import { formatStocksTextList } from "../messaging/stock-formatting";
import type { FormatPreferences, UserRecord } from "../messaging/types";
import type { StockPriceMap } from "../price-fetcher";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { loadUserStocks } from "./helpers";
import {
	processScheduledUserEmailDelivery,
	processScheduledUserSmsDelivery,
} from "./run-user-delivery";
import { updateUserNextSendAt } from "./run-user-next-send-at";
import type { SmsSenderProvider } from "./run-user-sms-sender";

type DbUserUpdate = Database["public"]["Tables"]["users"]["Update"];

function canInvokeGrokWithinWindow(options: {
	lastInvokedAtIso: string | null;
	currentTimeUtc: DateTime;
	windowHours: number;
}): boolean {
	if (!options.lastInvokedAtIso) {
		return true;
	}
	const last = DateTime.fromISO(options.lastInvokedAtIso, { zone: "utc" });
	if (!last.isValid) {
		return true;
	}
	return (
		options.currentTimeUtc.diff(last, "hours").hours >= options.windowHours
	);
}

export async function processScheduledUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	priceMap: StockPriceMap;
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
	let attemptedDeliveryMethod: DeliveryMethod | null = null;
	const {
		user,
		supabase,
		logger,
		sendEmail,
		currentTime,
		getSmsSender,
		priceMap,
		marketOpen,
	} = options;

	try {
		/* =============
		Cron vs manual schedule anchoring
		Normal cron only processes users with next_send_at set; manual sends (--force)
		may include users without next_send_at (e.g. newly enabled scheduled updates). In that case,
		use "now" as the schedule anchor.
		============= */
		const dueAt = user.next_send_at
			? DateTime.fromISO(user.next_send_at, { zone: "utc" })
			: currentTime;
		if (!dueAt.isValid) {
			logger.error("Invalid next_send_at timestamp", {
				userId: user.id,
				next_send_at: user.next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error("Failed to format local date for timezone", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error("Failed to format scheduled date", {
				userId: user.id,
				timezone: user.timezone,
				next_send_at: user.next_send_at,
				dueAt: dueAt.toISO(),
				dueAtLocalIso: dueAtLocal.toISO(),
			});
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error("Failed to calculate scheduled minutes", {
				action: "scheduled_notifications_run",
				phase: "getLocalMinutesFromDateTime",
				userId: user.id,
				timezone: user.timezone,
				next_send_at: user.next_send_at,
				dueAt: dueAt.toISO(),
				dueAtLocalIso: dueAtLocal.toISO(),
				scheduledDate,
			});
			stats.skipped++;
			return stats;
		}

		const userStocks = await loadUserStocks(supabase, user.id);
		const formatPrefs: FormatPreferences = {
			show_change_percent: user.show_change_percent,
			show_company_name: user.show_company_name,
			detailed_format: user.detailed_format,
		};
		const stocksList = formatStocksTextList(
			userStocks,
			(symbol) => priceMap.get(symbol) ?? undefined,
			formatPrefs,
		);

		const shouldAttemptSms = shouldSendSms(user);

		let smsExtras: { news?: string | null; rumors?: string | null } | undefined;
		if (
			shouldAttemptSms &&
			(user.first_notification_include_news ||
				user.first_notification_include_rumors) &&
			canInvokeGrokWithinWindow({
				lastInvokedAtIso: user.last_grok_rumors_at,
				currentTimeUtc: currentTime,
				windowHours: 24,
			})
		) {
			const extras = await generateFirstNotificationExtrasWithGrok({
				tickers: userStocks.map((s) => s.symbol),
				localDateIso: scheduledDate,
				timezone: user.timezone,
				includeNews: user.first_notification_include_news,
				includeRumors: user.first_notification_include_rumors,
			});
			if (extras?.news || extras?.rumors) {
				smsExtras = extras;
				const invokedAt = currentTime.toISO();
				if (invokedAt) {
					user.last_grok_rumors_at = invokedAt;
					const { error } = await supabase
						.from("users")
						.update({
							last_grok_rumors_at: invokedAt,
						} as unknown as DbUserUpdate)
						.eq("id", user.id);
					if (error) {
						logger.error(
							"Failed to update last_grok_rumors_at",
							{ userId: user.id, invokedAt },
							error,
						);
					}
				}
			}
		}

		/* ============= Process Email ============= */
		if (user.email_notifications_enabled) {
			attemptedDeliveryMethod = "email";
			await processScheduledUserEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				stocksList,
				sendEmail,
				priceMap,
				marketOpen,
				stats,
				formatPrefs,
			});
		}

		/* ============= Process SMS ============= */
		if (shouldAttemptSms) {
			attemptedDeliveryMethod = "sms";
			await processScheduledUserSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				stocksList,
				getSmsSender,
				marketOpen,
				stats,
				smsExtras,
			});
		}

		await updateUserNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing user", { userId: user.id }, error);

		try {
			const deliveryAttempts =
				stats.emailsSent + stats.emailsFailed + stats.smsSent + stats.smsFailed;

			// Avoid false negatives: if delivery already happened (or was at least recorded as
			// attempted), a later failure (e.g. updating next_send_at) shouldn't log as undelivered.
			if (deliveryAttempts === 0) {
				const deliveryMethod: DeliveryMethod =
					attemptedDeliveryMethod ??
					(user.email_notifications_enabled ? "email" : "sms");
				const logged = await recordNotification(supabase, {
					user_id: user.id,
					type: "scheduled_update",
					delivery_method: deliveryMethod,
					message_delivered: false,
					message: "Error processing notification",
					error: error instanceof Error ? error.message : String(error),
				});
				if (!logged) {
					stats.logFailures++;
				}
			}
		} catch (logError) {
			logger.error(
				"Failed to record notification for user",
				{ userId: user.id },
				logError,
			);
			stats.logFailures++;
		}

		return stats;
	}
}
