import { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { shouldSendSms } from "../messaging/sms";
import type {
	FormatPreferences,
	UserRecord,
	UserStockRow,
} from "../messaging/types";
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

function formatStockPrice(
	price: { price: number; changePercent: number },
	showChangePercent: boolean,
) {
	if (!showChangePercent) {
		return `$${price.price.toFixed(2)}`;
	}
	const sign = price.changePercent >= 0 ? "+" : "";
	return `$${price.price.toFixed(2)} (${sign}${price.changePercent.toFixed(2)}%)`;
}

/**
 * Build the stock lines for a delivery message based on user format preferences.
 */
function buildStocksList(
	userStocks: UserStockRow[],
	priceMap: StockPriceMap,
	formatPrefs: FormatPreferences,
): string {
	if (userStocks.length === 0) {
		return "You don't have any tracked stocks";
	}

	const separator = formatPrefs.detailed_format ? "\n\n" : "\n";
	return userStocks
		.map((stock) => {
			const price = priceMap.get(stock.symbol);
			const base = formatPrefs.show_company_name
				? `${stock.symbol} - ${stock.name}`
				: stock.symbol;
			if (price) {
				return `${base} — ${formatStockPrice(price, formatPrefs.show_change_percent)}`;
			}
			return base;
		})
		.join(separator);
}

/**
 * Process a single scheduled user: render message content, deliver via enabled channels,
 * record delivery attempts, and advance `next_send_at`.
 */
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
		const stocksList = buildStocksList(userStocks, priceMap, formatPrefs);

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
		if (shouldSendSms(user)) {
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
