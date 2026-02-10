import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { formatAssetsTextList } from "../messaging/asset-formatting";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { shouldSendSms } from "../messaging/sms";
import type { FormatPreferences, UserRecord } from "../messaging/types";
import type { AssetPriceMap } from "../price-fetcher";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { loadUserAssets } from "./helpers";
import {
	processScheduledUserEmailDelivery,
	processScheduledUserSmsDelivery,
} from "./run-user-delivery";
import { updateUserNextSendAt } from "./run-user-next-send-at";
import type { SmsSenderProvider } from "./run-user-sms-sender";

/**
 * Process a single user's scheduled (frequent) asset update notification.
 *
 * Computes a deterministic schedule key (local date + local minutes) from `next_send_at`,
 * formats the assets list, delivers via enabled channels, records delivery attempts, and
 * advances `next_send_at`.
 */
export async function processScheduledUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	priceMap: AssetPriceMap;
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

		const userAssets = await loadUserAssets(supabase, user.id);
		const formatPrefs: FormatPreferences = {
			show_change_percent: user.show_change_percent,
			show_company_name: user.show_company_name,
			detailed_format: user.detailed_format,
		};
		const assetsList = formatAssetsTextList(
			userAssets,
			(symbol) => priceMap.get(symbol) ?? undefined,
			formatPrefs,
		);

		const shouldAttemptSms = shouldSendSms(user);

		/* ============= Process Email ============= */
		if (user.email_notifications_enabled && user.price_include_email) {
			attemptedDeliveryMethod = "email";
			await processScheduledUserEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetsList,
				sendEmail,
				priceMap,
				marketOpen,
				stats,
				formatPrefs,
			});
		}

		/* ============= Process SMS ============= */
		if (shouldAttemptSms && user.price_include_sms) {
			attemptedDeliveryMethod = "sms";
			await processScheduledUserSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetsList,
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
				const shouldAttemptSms = shouldSendSms(user);
				const eligibleEmail =
					user.email_notifications_enabled && user.price_include_email;
				const eligibleSms = shouldAttemptSms && user.price_include_sms;

				const deliveryMethod: DeliveryMethod =
					attemptedDeliveryMethod ??
					(eligibleEmail
						? "email"
						: eligibleSms
							? "sms"
							: user.email_notifications_enabled
								? "email"
								: "sms");
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
