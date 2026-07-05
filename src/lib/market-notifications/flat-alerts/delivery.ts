import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { sendUserEmail } from "../../messaging/email/index";
import { type createLogoCache, fetchLogoBase64, renderLogoImg } from "../../messaging/logo-fetcher";
import { isFacetEnabled } from "../../messaging/notification-prefs";
import type { SparklineData } from "../../messaging/parts/sparkline";
import { deliveryResultToLogFields, recordNotification } from "../../messaging/shared";
import { sendUserSms, shouldSendSms } from "../../messaging/sms/index";
import { isTelegramChannelUsable, shouldSendTelegram } from "../../messaging/telegram/eligibility";
import { deliverTelegramPriceAlert } from "../../messaging/telegram/price-alert";
import type { EmailSender, SmsSender, TelegramSender } from "../../messaging/types";
import { buildFlatAlertEnriched } from "../../price-alerts/compose";
import type { ChannelDeliveryStats, ExtendedAssetQuote, IntradayBarsResult } from "../../types";
import {
	buildSubject,
	formatFlatPriceAlertEmail,
	formatFlatPriceAlertSms,
	formatRelativeMinutesAgo,
} from "./format";
import type { FlatPriceAlertUser } from "./users";

/** Deliver a flat price alert across the channels the user has enabled
 *  (email and/or SMS) and record each attempt in notification_log. */
export async function deliverFlatPriceAlert(options: {
	user: FlatPriceAlertUser;
	symbol: string;
	companyName: string;
	quote: ExtendedAssetQuote;
	baseline: number;
	triggerPercent: number;
	isReTrigger: boolean;
	lastNotificationAt: Date | null;
	nowMs: number;
	intraday: IntradayBarsResult | null;
	sevenDaySparkline: SparklineData | null;
	iconUrl: string | null;
	iconBase64: string | null;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	/** Telegram sender, threaded the same way as `sendSms` (lazy provider in process.ts). */
	sendTelegram?: TelegramSender | null;
	logoCache: ReturnType<typeof createLogoCache>;
	stats: ChannelDeliveryStats;
}): Promise<boolean> {
	const {
		user,
		symbol,
		companyName,
		quote,
		baseline,
		triggerPercent,
		isReTrigger,
		lastNotificationAt,
		nowMs,
		intraday,
		sevenDaySparkline,
		iconUrl,
		iconBase64,
		supabase,
		sendEmail,
		sendSms,
		sendTelegram,
		logoCache,
		stats,
	} = options;

	let delivered = false;

	// Email
	if (
		isFacetEnabled(user.prefs, "price_move_alerts", "email") &&
		user.email_notifications_enabled
	) {
		const logoDataUri = await fetchLogoBase64(symbol, iconUrl, logoCache, iconBase64, supabase);
		const logoHtml = logoDataUri ? renderLogoImg(logoDataUri) : undefined;

		const message = formatFlatPriceAlertEmail({
			user,
			symbol,
			companyName,
			quote,
			baseline,
			isReTrigger,
			lastNotificationAt,
			nowMs,
			intraday,
			sevenDaySparkline,
			logoHtml,
		});

		const subject = buildSubject({
			symbol,
			currentPrice: quote.price,
			triggerPercent,
			isReTrigger,
		});

		// Dedup is the flat-alert reserve/finalize CAS (reserve_flat_price_alert), not an
		// email-level key: the direct-SES path does not honor idempotency keys, so a
		// claim that fails open CAN double-send. The reserve CAS is the real guard.
		const result = await sendUserEmail(user, subject, message, sendEmail);

		if (result.success) {
			stats.emailsSent++;
			delivered = true;
		} else {
			stats.emailsFailed++;
			rootLogger.error(
				"Failed to send flat price alert email",
				{ userId: user.id, symbol, triggerPercent, isReTrigger },
				result.error,
			);
		}

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "flat_price_alert",
			delivery_method: "email",
			message_delivered: result.success,
			message: message.text,
			...deliveryResultToLogFields(result),
		});
		if (!logged) stats.logFailures++;
	}

	// SMS
	if (isFacetEnabled(user.prefs, "price_move_alerts", "sms") && sendSms) {
		if (!shouldSendSms(user)) {
			// Channel ineligibility is a config skip, NOT a delivery failure — leave it
			// uncounted, matching the scheduled paths.
			rootLogger.info("Flat price alert SMS skipped: user not eligible", {
				userId: user.id,
				symbol,
			});
		} else {
			const smsBody = formatFlatPriceAlertSms({
				symbol,
				quote,
				baseline,
				triggerPercent,
				isReTrigger,
				lastNotificationAt,
				nowMs,
				intraday,
				sevenDaySparkline,
			});
			const result = await sendUserSms(user, smsBody, sendSms, supabase);

			if (result.success) {
				stats.smsSent++;
				delivered = true;
			} else {
				stats.smsFailed++;
				rootLogger.error(
					"Failed to send flat price alert SMS",
					{ userId: user.id, symbol, triggerPercent, isReTrigger },
					result.error,
				);
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "flat_price_alert",
				delivery_method: "sms",
				message_delivered: result.success,
				message: smsBody,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;
		}
	}

	// Telegram delivery (additive; never alters the email/SMS paths above). Real-time
	// alert — no claim RPC; the per-symbol flat-alert reservation already deduped this
	// symbol×user, so Telegram piggybacks. Only query per-option prefs for users whose
	// channel is usable (linked + not opted out).
	if (sendTelegram && isTelegramChannelUsable(user)) {
		if (shouldSendTelegram(user, user.prefs, "price_move_alerts")) {
			const since =
				isReTrigger && lastNotificationAt !== null
					? formatRelativeMinutesAgo(lastNotificationAt.getTime(), nowMs)
					: "today";
			const enriched = buildFlatAlertEnriched({ symbol, quote, triggerPercent, since, intraday });
			const sent = await deliverTelegramPriceAlert({
				alert: enriched,
				user,
				sendTelegram,
				supabase,
				stats,
			});
			if (sent) {
				delivered = true;
			}
		}
	}

	return delivered;
}
