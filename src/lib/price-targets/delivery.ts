import { DASHBOARD_SECTION_HASHES } from "../constants";
import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { escapeHtml } from "../messaging/asset-formatting";
import { sendUserEmail } from "../messaging/email/index";
import { createEmailUnsubscribeUrl } from "../messaging/email/unsubscribe";
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
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const scheduleUrl = `${dashboardUrl}${DASHBOARD_SECTION_HASHES.marketNotifications}`;
	const unsubscribeUrl = createEmailUnsubscribeUrl({
		userId: user.id,
		email: user.email,
	});

	// Plaintext
	const textSections = [
		`Price Target Hit: ${target.symbol}`,
		`${target.symbol} hit your price target of ${formatPrice(target.targetPrice)} (currently ${formatPrice(target.currentPrice)}).`,
		`Your ${target.direction === "above" ? "upward" : "downward"} price target has been triggered and automatically cleared.`,
		`Manage your notifications: ${scheduleUrl}`,
		`Unsubscribe from all emails: ${unsubscribeUrl}`,
	];
	const text = textSections.join("\n\n");

	// HTML
	const directionLabel = target.direction === "above" ? "rose to" : "fell to";
	const escapedSymbol = escapeHtml(target.symbol);
	const escapedScheduleUrl = escapeHtml(scheduleUrl);
	const escapedDashboardUrl = escapeHtml(dashboardUrl);
	const escapedUnsubscribeUrl = escapeHtml(unsubscribeUrl);

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Price Target Hit</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">${logoHtml ?? ""}${escapedSymbol}</h2>
		<div style="background: #eef2ff; padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #c7d2fe;">
			<p style="color: #4338ca; font-size: 16px; font-weight: 500; margin: 0;">
				${escapedSymbol} ${directionLabel} ${formatPrice(target.currentPrice)}, hitting your target of ${formatPrice(target.targetPrice)}.
			</p>
		</div>
		<p style="color: #6b7280; font-size: 14px;">
			This price target has been automatically cleared. You can set a new target from the dashboard.
		</p>
		<div style="text-align: center; margin-top: 30px;">
			<a href="${escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				View Dashboard &rarr;
			</a>
		</div>
		<p style="color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
			<a href="${escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Manage alerts</a>
			<span style="color: #d1d5db; padding: 0 8px;">&bull;</span>
			<a href="${escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
		</p>
	</div>
</body>
</html>`;

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
