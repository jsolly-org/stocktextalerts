import type { Logger } from "../../logging";
import {
	createErrorForLogging,
	extractErrorMessage,
} from "../../logging/errors";
import { processEmailUpdate } from "../../messaging/email/delivery";
import type { EmailSender } from "../../messaging/email/utils";
import { recordNotification } from "../../messaging/shared";
import { processSmsUpdate } from "../../messaging/sms/delivery";
import type { SparklineData } from "../../messaging/sparkline";
import type {
	FormatPreferences,
	UserAssetRow,
	UserRecord,
} from "../../messaging/types";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../../schedule/helpers";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../../schedule/helpers";
import type { SmsSenderProvider } from "../../schedule/sms-sender";
import type { MarketClosureInfo } from "../../time/market-calendar";

/**
 * Deliver a scheduled market asset update via email and record the result.
 *
 * Uses `claim_scheduled_notification` for idempotency, then writes the final status to
 * `scheduled_notifications` and logs a notification row.
 */
export async function processMarketScheduledEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetsList: string;
	sendEmail: EmailSender;
	priceMap: AssetPriceMap;
	marketOpen: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	stats: ScheduledNotificationTotals;
	formatPrefs?: FormatPreferences;
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
}): Promise<void> {
	const {
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
		marketClosureInfo,
		stats,
		formatPrefs,
		getSparkline,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.emailsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted") {
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `scheduled-update/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const { sent, logged, error } = await processEmailUpdate(
		supabase,
		user,
		userAssets,
		assetsList,
		sendEmail,
		priceMap,
		marketOpen,
		emailIdempotencyKey,
		formatPrefs,
		getSparkline,
		marketClosureInfo,
	);

	if (sent) {
		stats.emailsSent++;
	} else {
		stats.emailsFailed++;
	}

	if (!logged) {
		stats.logFailures++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}

/**
 * Deliver a scheduled market asset update via SMS and record the result.
 *
 * Uses `claim_scheduled_notification` for idempotency. SMS sender initialization can fail
 * (e.g. missing Twilio config); that failure is recorded and the notification is marked failed.
 */
export async function processMarketScheduledSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetsList: string;
	getSmsSender: SmsSenderProvider;
	marketOpen: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		assetsList,
		getSmsSender,
		marketOpen,
		marketClosureInfo,
		stats,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.smsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted") {
		stats.skipped++;
		return;
	}

	let smsSenderResult: ReturnType<SmsSenderProvider>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender",
			{
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				channel: "sms",
				errorMessage,
				stats,
			},
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "market",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "market",
			delivery_method: "sms",
			message_delivered: false,
			message: "SMS service unavailable",
			error: errorMessage,
		});
		if (!logged) {
			stats.logFailures++;
		}

		return;
	}
	const smsSender = smsSenderResult.sender;

	const { sent, logged, error } = await processSmsUpdate(
		supabase,
		user,
		assetsList,
		smsSender,
		marketOpen,
		undefined,
		marketClosureInfo,
	);

	if (sent) {
		stats.smsSent++;
	} else {
		stats.smsFailed++;
	}

	if (!logged) {
		stats.logFailures++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "market",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}
