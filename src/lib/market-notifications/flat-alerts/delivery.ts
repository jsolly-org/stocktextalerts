import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { resolveOutboundChannel } from "../../messaging/delivery-channel";
import { sendUserEmail } from "../../messaging/email/index";
import {
	type createLogoCache,
	EMAIL_LOGO_SIZE_HERO,
	fetchLogoBase64,
	renderLogoImg,
} from "../../messaging/logo-fetcher";
import { isFacetEnabled } from "../../messaging/notification-prefs";
import type { SparklineData } from "../../messaging/parts/sparkline";
import { deliveryResultToLogFields, recordNotification } from "../../messaging/shared";
import { deliverTelegramPriceAlert } from "../../messaging/telegram/price-alert";
import type { EmailSender, TelegramSender } from "../../messaging/types";
import { consumeNotificationBudget, releaseNotificationBudget } from "../../notification-budget";
import { buildFlatAlertEnriched } from "../../price-alerts/compose";
import type {
	ActiveMarketSession,
	ChannelDeliveryStats,
	ExtendedAssetQuote,
	IntradayBarsResult,
} from "../../types";
import { wakeupAssetBuyerFromFlatAlert, wakeupQuoteFromExtended } from "./asset-buyer-wakeup";
import { buildSubject, formatFlatPriceAlertEmail, formatRelativeMinutesAgo } from "./format";
import type { FlatPriceAlertUser } from "./users";

/** Deliver a flat price alert on the account's single delivery channel
 *  and record the attempt in notification_log. */
export async function deliverFlatPriceAlert(options: {
	user: FlatPriceAlertUser;
	symbol: string;
	companyName: string;
	quote: ExtendedAssetQuote;
	baseline: number;
	triggerPercent: number;
	isReTrigger: boolean;
	isAcceleration: boolean;
	lastNotificationAt: Date | null;
	nowMs: number;
	intraday: IntradayBarsResult | null;
	sevenDaySparkline: SparklineData | null;
	iconUrl: string | null;
	iconBase64: string | null;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	/** Telegram sender, threaded as a lazy provider in process.ts. */
	sendTelegram?: TelegramSender | null;
	logoCache: ReturnType<typeof createLogoCache>;
	stats: ChannelDeliveryStats;
	/** Optional Grok why blurb; omit/null when budget/XAI/Grok fail open. */
	whyText?: string | null;
	/** Absolute URL to the auth-gated full report; omit when no packet was saved. */
	reportUrl?: string | null;
	/** Full catalyst packet forwarded to the asset-buyer wakeup; omitted when why was omitted. */
	catalystPacket?: Record<string, unknown> | null;
	/** Required for lambda wakeup so heartbeat does not re-quote Massive. */
	session?: ActiveMarketSession;
}): Promise<boolean> {
	const {
		user,
		symbol,
		companyName,
		quote,
		baseline,
		triggerPercent,
		isReTrigger,
		isAcceleration,
		lastNotificationAt,
		nowMs,
		intraday,
		sevenDaySparkline,
		iconUrl,
		iconBase64,
		supabase,
		sendEmail,
		sendTelegram,
		logoCache,
		stats,
		whyText,
		reportUrl,
		catalystPacket,
		session,
	} = options;

	let delivered = false;
	const contentEnabled = isFacetEnabled(user.prefs, "price_move_alerts");
	const outbound = resolveOutboundChannel(user);

	// System / stock-buyer users: Lambda wakeup only (no email/Telegram, no
	// notification_log — delivery_method enum is email|telegram only). They run
	// the same why toolkit as humans, so the packet rides along when there is one.
	if (user.delivery_channel === "lambda") {
		if (!contentEnabled) {
			rootLogger.info("Skipped lambda flat alert: price_move_alerts facet off", {
				userId: user.id,
				symbol,
			});
			return false;
		}
		if (!session) {
			rootLogger.warn("Lambda flat alert wakeup skipped: missing session", {
				userId: user.id,
				symbol,
			});
			return false;
		}
		const woke = await wakeupAssetBuyerFromFlatAlert({
			symbol,
			triggerPercent,
			isAcceleration,
			quote: wakeupQuoteFromExtended(quote),
			session,
			...(catalystPacket ? { catalystPacket } : {}),
		});
		if (!woke) {
			rootLogger.warn("Lambda flat alert wakeup failed", {
				userId: user.id,
				symbol,
				triggerPercent,
				isAcceleration,
			});
			return false;
		}
		rootLogger.info("Lambda flat alert wakeup completed (no human notification_log)", {
			userId: user.id,
			symbol,
			triggerPercent,
			isAcceleration,
			packetAttached: Boolean(catalystPacket),
		});
		return true;
	}

	if (contentEnabled && outbound === "email") {
		const consume = await consumeNotificationBudget(supabase, {
			userId: user.id,
			kind: "price_move_alerts",
		});
		if (consume.status === "reserved") {
			const logoDataUri = await fetchLogoBase64(symbol, iconUrl, logoCache, iconBase64, supabase);
			const logoHtml = logoDataUri ? renderLogoImg(logoDataUri, EMAIL_LOGO_SIZE_HERO) : undefined;

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
				whyText,
				reportUrl,
			});

			const subject = buildSubject({
				symbol,
				currentPrice: quote.price,
				triggerPercent,
				isReTrigger,
				isAcceleration,
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
				await releaseNotificationBudget(supabase, {
					userId: user.id,
					kind: "price_move_alerts",
				});
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
		} else if (consume.status === "denied") {
			rootLogger.info("Skipped flat price alert email: notification budget exhausted", {
				userId: user.id,
				symbol,
			});
		} else {
			rootLogger.info("Skipped flat price alert email: notification budget check failed", {
				userId: user.id,
				symbol,
			});
		}
	}

	// Telegram — only when the account is routed to telegram (linked chat required).
	else if (sendTelegram && contentEnabled && outbound === "telegram") {
		const consume = await consumeNotificationBudget(supabase, {
			userId: user.id,
			kind: "price_move_alerts",
		});
		if (consume.status === "reserved") {
			const since = !isReTrigger
				? "today"
				: lastNotificationAt !== null
					? `since last alert (${formatRelativeMinutesAgo(lastNotificationAt.getTime(), nowMs)})`
					: "since last alert";
			const enriched = buildFlatAlertEnriched({
				symbol,
				quote,
				triggerPercent,
				since,
				intraday,
				isAcceleration,
				why: whyText,
			});
			const sent = await deliverTelegramPriceAlert({
				alert: enriched,
				user,
				sendTelegram,
				supabase,
				stats,
				fullReportUrl: reportUrl,
			});
			if (sent) {
				delivered = true;
			} else {
				await releaseNotificationBudget(supabase, {
					userId: user.id,
					kind: "price_move_alerts",
				});
			}
		} else if (consume.status === "denied") {
			rootLogger.info("Skipped flat price alert Telegram: notification budget exhausted", {
				userId: user.id,
				symbol,
			});
		} else {
			rootLogger.info("Skipped flat price alert Telegram: notification budget check failed", {
				userId: user.id,
				symbol,
			});
		}
	}

	return delivered;
}
