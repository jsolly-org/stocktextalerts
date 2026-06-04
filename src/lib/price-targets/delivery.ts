import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { escapeHtml } from "../messaging/asset-formatting";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter, renderEmailShell } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { createLogoCache, fetchLogoBase64, renderLogoImg } from "../messaging/logo-fetcher";
import { recordNotification } from "../messaging/shared";
import { isSmsChannelUsable, sendUserSms } from "../messaging/sms/index";
import { padUrlsToSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SmsSender } from "../messaging/sms/twilio-utils";
import type { PriceTargetUser, TriggeredPriceTarget } from "./process";

/** Per-run delivery counters for price target notifications. */
export interface PriceTargetDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	logFailures: number;
}

function formatPrice(price: number): string {
	return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format the SMS body for a price target alert.
 */
export function formatPriceTargetSms(target: TriggeredPriceTarget): string {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const optOutSuffix = "Reply STOP to opt out.";

	const sections = [
		`StockTextAlerts — Price Target Hit`,
		`${target.symbol} hit your price target of ${formatPrice(target.targetPrice)} (currently ${formatPrice(target.currentPrice)})`,
		`Manage your notifications: ${dashboardUrl}`,
		optOutSuffix,
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
		`${target.symbol} hit your price target of ${formatPrice(target.targetPrice)} (currently ${formatPrice(target.currentPrice)}).`,
		`Your ${target.direction === "above" ? "upward" : "downward"} price target has been triggered and automatically cleared.`,
		`Manage your notifications: ${urls.scheduleUrl}`,
		`Unsubscribe from all emails: ${urls.unsubscribeUrl}`,
	];
	const text = textSections.join("\n\n");

	// HTML
	const directionLabel = target.direction === "above" ? "rose to" : "fell to";
	const escapedSymbol = escapeHtml(target.symbol);

	const html = renderEmailShell({
		bodyHtml: `<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Price Target Hit: ${logoHtml ?? ""}${escapedSymbol}</h2>
		<div style="background: #eef2ff; padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #c7d2fe;">
			<p style="color: #4338ca; font-size: 16px; font-weight: 500; margin: 0;">
				${escapedSymbol} ${directionLabel} ${formatPrice(target.currentPrice)}, hitting your target of ${formatPrice(target.targetPrice)}.
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
 * Deliver a price target alert to a user via their preferred channels.
 * @returns true if at least one notification was successfully sent (email or SMS).
 */
export async function deliverPriceTargetAlert(options: {
	user: PriceTargetUser;
	target: TriggeredPriceTarget;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	stats: PriceTargetDeliveryStats;
	logoCache?: ReturnType<typeof createLogoCache>;
}): Promise<boolean> {
	const { user, target, supabase, sendEmail, sendSms, stats } = options;
	const logoCache = options.logoCache ?? createLogoCache();
	let delivered = false;

	// Email delivery
	if (user.price_targets_include_email) {
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
			delivered = true;
		} else {
			stats.emailsFailed++;
		}

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "price_target",
			delivery_method: "email",
			message_delivered: result.success,
			message: message.text,
			error: result.success ? undefined : result.error,
		});
		if (!logged) stats.logFailures++;
	}

	// SMS delivery
	if (user.price_targets_include_sms) {
		if (!sendSms) {
			rootLogger.error(
				"Price target SMS sender unavailable",
				{ userId: user.id },
				new Error("Price target SMS sender unavailable"),
			);
			stats.smsFailed++;
		} else if (!isSmsChannelUsable(user)) {
			rootLogger.info("Price target SMS skipped: user not eligible", {
				userId: user.id,
			});
			stats.smsFailed++;
		} else {
			const smsBody = formatPriceTargetSms(target);
			const result = await sendUserSms(user, smsBody, sendSms, supabase);

			if (result.success) {
				stats.smsSent++;
				delivered = true;
			} else {
				stats.smsFailed++;
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "price_target",
				delivery_method: "sms",
				message_delivered: result.success,
				message: smsBody,
				error: result.success ? undefined : result.error,
			});
			if (!logged) stats.logFailures++;
		}
	}

	return delivered;
}
