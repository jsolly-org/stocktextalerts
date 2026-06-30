import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { isEmailChannelUsable } from "../messaging/email/eligibility";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter, renderEmailShell } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { createLogoCache, fetchLogoBase64, renderLogoImg } from "../messaging/logo-fetcher";
import { isFacetEnabled } from "../messaging/notification-prefs";
import { formatUsdPrice } from "../messaging/parts/asset-price-list";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT } from "../messaging/parts/footer";
import { escapeHtml } from "../messaging/parts/html-utils";
import { deliveryResultToLogFields, recordNotification } from "../messaging/shared";
import { isSmsChannelUsable, sendUserSms } from "../messaging/sms/index";
import { padUrlsToSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SmsSender } from "../messaging/sms/twilio-utils";
import { shouldSendTelegram } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import { formatPriceAlertTelegram } from "../messaging/telegram/price-alert";
import type { TelegramSender } from "../messaging/telegram/sender";
import { buildPriceTargetEnriched } from "../price-alerts/compose";
import type { PriceTargetUser, TriggeredPriceTarget } from "./process";

/** Per-run delivery counters for price target notifications. */
export interface PriceTargetDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
	logFailures: number;
}

/** Outcome of one channel in a single delivery round. `skipped` means the channel
 *  was not attempted (not wanted, not usable, or already delivered on a prior round). */
type PriceTargetChannelOutcome = "sent" | "failed" | "skipped";

/** Per-channel outcome of one `deliverPriceTargetAlert` round. The caller uses this
 *  to decide when every *required* channel has reached a terminal (sent) state. */
export interface PriceTargetDeliveryOutcome {
	email: PriceTargetChannelOutcome;
	sms: PriceTargetChannelOutcome;
	telegram: PriceTargetChannelOutcome;
}

/**
 * Format the SMS body for a price target alert.
 */
export function formatPriceTargetSms(target: TriggeredPriceTarget): string {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const sections = [
		`StockTextAlerts — Price Target Hit`,
		`${target.symbol} hit your price target of ${formatUsdPrice(target.targetPrice)} (currently ${formatUsdPrice(target.currentPrice)})`,
		`Manage your notifications: ${dashboardUrl}`,
		SMS_OPT_OUT,
		NOT_FINANCIAL_ADVICE,
	];

	return padUrlsToSegmentBoundaries(sections.join("\n\n"));
}

/**
 * Format the email body for a price target alert.
 */
function formatPriceTargetEmail(
	user: PriceTargetUser,
	target: TriggeredPriceTarget,
	logoHtml?: string,
): { text: string; html: string } {
	const urls = buildEmailUrls(user.id, user.email, "marketNotifications");

	// Plaintext
	const textSections = [
		`Price Target Hit: ${target.symbol}`,
		`${target.symbol} hit your price target of ${formatUsdPrice(target.targetPrice)} (currently ${formatUsdPrice(target.currentPrice)}).`,
		`Your ${target.direction === "above" ? "upward" : "downward"} price target has been triggered and automatically cleared.`,
		`Manage your notifications: ${urls.scheduleUrl}`,
		`Unsubscribe from all emails: ${urls.unsubscribeUrl}`,
		NOT_FINANCIAL_ADVICE,
	];
	const text = textSections.join("\n\n");

	// HTML
	const directionLabel = target.direction === "above" ? "rose to" : "fell to";
	const escapedSymbol = escapeHtml(target.symbol);

	const html = renderEmailShell({
		bodyHtml: `<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Price Target Hit: ${logoHtml ?? ""}${escapedSymbol}</h2>
		<div style="background: #eef2ff; padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #c7d2fe;">
			<p style="color: #4338ca; font-size: 16px; font-weight: 500; margin: 0;">
				${escapedSymbol} ${directionLabel} ${formatUsdPrice(target.currentPrice)}, hitting your target of ${formatUsdPrice(target.targetPrice)}.
			</p>
		</div>
		<p style="color: #6b7280; font-size: 14px;">
			This price target has been automatically cleared. You can set a new target from the dashboard.
		</p>
		<div style="text-align: center; margin-top: 30px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				View Dashboard &rarr;
			</a>
		</div>`,
		footerHtml: renderEmailFooter(urls),
	});

	return { text, html };
}

/**
 * Deliver a price target alert to a user via their enabled + usable channels.
 *
 * Per-channel and idempotent across retry rounds: a channel already delivered for
 * this trigger (its `*_delivered_at` column set, surfaced via `alreadyDelivered`)
 * is skipped so it is never re-sent. Channel ineligibility (e.g. SMS opted-out /
 * unverified phone) is `skipped`, not `failed`, so it never blocks terminal state.
 *
 * @returns the per-channel outcome so the caller can decide when every *required*
 *   channel has reached a terminal (sent) state and the target can be cleared.
 */
export async function deliverPriceTargetAlert(options: {
	user: PriceTargetUser;
	target: TriggeredPriceTarget;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	/** Telegram sender, threaded the same way as `sendSms` (lazy provider in process.ts). */
	sendTelegram?: TelegramSender | null;
	stats: PriceTargetDeliveryStats;
	logoCache?: ReturnType<typeof createLogoCache>;
	/** Channels already delivered on a prior retry round (from the row's
	 *  `*_delivered_at` columns). Delivered channels are skipped, never re-sent. */
	alreadyDelivered?: { email: boolean; sms: boolean; telegram: boolean };
}): Promise<PriceTargetDeliveryOutcome> {
	const { user, target, supabase, sendEmail, sendSms, sendTelegram, stats } = options;
	const logoCache = options.logoCache ?? createLogoCache();
	const alreadyDelivered = options.alreadyDelivered ?? {
		email: false,
		sms: false,
		telegram: false,
	};
	const outcome: PriceTargetDeliveryOutcome = {
		email: "skipped",
		sms: "skipped",
		telegram: "skipped",
	};

	// Email delivery — gate on the global email kill-switch AND the per-option facet,
	// matching every sibling notification type (the facet alone does not imply the global flag).
	if (
		!alreadyDelivered.email &&
		isEmailChannelUsable(user) &&
		isFacetEnabled(user.prefs, "price_targets", "email")
	) {
		const logoDataUri = await fetchLogoBase64(
			target.symbol,
			target.iconUrl,
			logoCache,
			target.iconBase64,
			supabase,
		);
		const logoHtml = logoDataUri ? renderLogoImg(logoDataUri) : undefined;
		const message = formatPriceTargetEmail(user, target, logoHtml);
		const result = await sendUserEmail(
			user,
			`${target.symbol} Price Target Hit`,
			message,
			sendEmail,
		);

		if (result.success) {
			stats.emailsSent++;
			outcome.email = "sent";
		} else {
			stats.emailsFailed++;
			outcome.email = "failed";
		}

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "price_target",
			delivery_method: "email",
			message_delivered: result.success,
			message: message.text,
			...deliveryResultToLogFields(result),
		});
		if (!logged) stats.logFailures++;
	}

	// SMS delivery
	if (!alreadyDelivered.sms && isFacetEnabled(user.prefs, "price_targets", "sms")) {
		if (!isSmsChannelUsable(user)) {
			// Ineligible (opted out / unverified phone): the channel can never deliver,
			// so it is skipped (not a failure) — it must not block terminal state nor be retried.
			rootLogger.info("Price target SMS skipped: user not eligible", {
				userId: user.id,
			});
		} else if (!sendSms) {
			rootLogger.error(
				"Price target SMS sender unavailable",
				{ userId: user.id },
				new Error("Price target SMS sender unavailable"),
			);
			stats.smsFailed++;
			outcome.sms = "failed";
		} else {
			const smsBody = formatPriceTargetSms(target);
			const result = await sendUserSms(user, smsBody, sendSms, supabase);

			if (result.success) {
				stats.smsSent++;
				outcome.sms = "sent";
			} else {
				stats.smsFailed++;
				outcome.sms = "failed";
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "price_target",
				delivery_method: "sms",
				message_delivered: result.success,
				message: smsBody,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;
		}
	}

	// Telegram delivery (additive; never alters the email/SMS paths above). Text-only:
	// price targets carry no intraday candles. `shouldSendTelegram` already folds in
	// channel usability (linked + not opted out) and the per-option pref.
	if (!alreadyDelivered.telegram && shouldSendTelegram(user, user.prefs, "price_targets")) {
		if (!sendTelegram) {
			rootLogger.error(
				"Price target Telegram sender unavailable",
				{ userId: user.id },
				new Error("Price target Telegram sender unavailable"),
			);
			stats.telegramFailed++;
			outcome.telegram = "failed";
		} else {
			const enriched = buildPriceTargetEnriched(target);
			const { text, entities, photo } = formatPriceAlertTelegram(enriched, []);
			const result = await sendTelegram({
				// telegram_chat_id is non-null here: isTelegramChannelUsable (folded into
				// shouldSendTelegram) requires it.
				chatId: user.telegram_chat_id as number,
				text,
				entities,
				...(photo ? { photo } : {}),
			});

			if (result.success) {
				stats.telegramSent++;
				outcome.telegram = "sent";
			} else {
				stats.telegramFailed++;
				outcome.telegram = "failed";
				rootLogger.error(
					"Failed to send price target Telegram message",
					{ userId: user.id, symbol: target.symbol, errorCode: result.errorCode ?? null },
					new Error(result.error ?? "Price target Telegram send failed"),
				);
			}

			await optOutIfBotBlocked(supabase, user.id, result);

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "price_target",
				delivery_method: "telegram",
				message_delivered: result.success,
				message: text,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;
		}
	}

	return outcome;
}
