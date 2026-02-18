import { DASHBOARD_SECTION_HASHES } from "../constants";
import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { escapeHtml, getChangeColor } from "../messaging/asset-formatting";
import { sendUserEmail } from "../messaging/email/index";
import { createEmailUnsubscribeUrl } from "../messaging/email/unsubscribe";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { SmsSender } from "../messaging/sms/twilio-utils";
import { toSparkline } from "../messaging/sparkline";
import { toSvgSparklineImg } from "../messaging/svg-sparkline";
import type { EnrichedAlert } from "./enrichment";
import type { PriceAlertUser } from "./users";

/** Max sparkline length for SMS. Unicode blocks use UCS-2 (70 chars/segment). Truncating reduces segment count and cost. */
const SMS_SPARKLINE_MAX_LENGTH = 12;

function formatPriceContextWithSparkline(
	priceContext: string,
	intradayCloses: number[] | null,
	maxSparklineLength?: number,
): string {
	if (!intradayCloses) return priceContext;

	let values = intradayCloses;
	if (maxSparklineLength !== undefined && maxSparklineLength < 2) {
		return priceContext;
	}
	if (maxSparklineLength !== undefined && values.length > maxSparklineLength) {
		// Downsample to preserve full-day shape; truncating would drop recent price data
		const sampled: number[] = [];
		for (let i = 0; i < maxSparklineLength; i++) {
			const idx = Math.round(
				(i / (maxSparklineLength - 1)) * (values.length - 1),
			);
			sampled.push(values[idx]);
		}
		values = sampled;
	}

	const sparkline = toSparkline(values);
	return sparkline ? `${priceContext} Today: ${sparkline}` : priceContext;
}

/** Counts of price-alert delivery outcomes (email/SMS sent/failed, notification log failures). */
export interface PriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	logFailures: number;
}

/**
 * Format the SMS body for a price alert.
 */
function formatPriceAlertSms(alert: EnrichedAlert): string {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const optOutSuffix = "Reply STOP to opt out.";

	const priceContextLine = formatPriceContextWithSparkline(
		alert.priceContext,
		alert.intradayCloses,
		SMS_SPARKLINE_MAX_LENGTH,
	);

	const sections = [
		"StockTextAlerts — Asset Price Alert 🚨",
		priceContextLine,
		`Signals: ${alert.signalContext}`,
	];

	if (alert.aiSummary) {
		const headlineUrls = alert.headlines
			.filter((h) => h.url)
			.map((h) => h.url)
			.join("\n");
		sections.push(
			headlineUrls ? `${alert.aiSummary}\n${headlineUrls}` : alert.aiSummary,
		);
	}

	sections.push(`Manage your settings: ${dashboardUrl}`);
	sections.push(optOutSuffix);

	return sections.join("\n\n");
}

function renderHtmlSparkline(intradayCloses: number[] | null): string {
	if (!intradayCloses || intradayCloses.length < 2) return "";
	if (intradayCloses.some((v) => !Number.isFinite(v))) return "";
	const openPrice = intradayCloses[0];
	const lastPrice = intradayCloses[intradayCloses.length - 1];
	const changePercent =
		openPrice === 0 ? 0 : ((lastPrice - openPrice) / openPrice) * 100;
	const color = getChangeColor(changePercent);
	const sparklineImg = toSvgSparklineImg(
		intradayCloses,
		color,
		200,
		40,
		"Intraday price chart since market open",
	);
	if (!sparklineImg) return "";
	return `
			<p style="color: #92400e; font-size: 12px; margin: 8px 0 0 0;">Today since open:</p>
			<div style="margin-top: 4px;">${sparklineImg}</div>`;
}

/**
 * Format the email body for a price alert.
 */
function formatPriceAlertEmail(
	user: PriceAlertUser,
	alert: EnrichedAlert,
): { text: string; html: string } {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const scheduleUrl = `${dashboardUrl}${DASHBOARD_SECTION_HASHES.marketNotifications}`;
	const unsubscribeUrl = createEmailUnsubscribeUrl({
		userId: user.id,
		email: user.email,
	});

	// Plaintext
	const textSparkline = alert.intradayCloses
		? toSparkline(alert.intradayCloses)
		: "";
	const textPriceContextLine = textSparkline
		? `${alert.priceContext} Today: ${textSparkline}`
		: alert.priceContext;

	const textSections = [
		`Asset Price Alert: ${alert.symbol}`,
		textPriceContextLine,
		`Signals: ${alert.signalContext}`,
	];

	if (alert.headlines.length > 0) {
		const headlineLines = alert.headlines
			.map((h) => `- ${h.headline}${h.url ? ` (${h.url})` : ""}`)
			.join("\n");
		textSections.push(`Breaking News:\n${headlineLines}`);
	}

	if (alert.aiSummary) {
		textSections.push(alert.aiSummary);
	}

	textSections.push(`Manage your settings: ${scheduleUrl}`);
	textSections.push(`Unsubscribe from all emails: ${unsubscribeUrl}`);

	const text = textSections.join("\n\n");

	// HTML
	const escapedDashboardUrl = escapeHtml(dashboardUrl);
	const escapedScheduleUrl = escapeHtml(scheduleUrl);
	const escapedUnsubscribeUrl = escapeHtml(unsubscribeUrl);

	const headlinesHtml =
		alert.headlines.length > 0
			? `
		<div style="margin-top: 20px;">
			<h3 style="color: #1f2937; font-size: 16px; font-weight: 600; margin: 0 0 10px 0;">Breaking News</h3>
			<ul style="margin: 0; padding-left: 20px; color: #4b5563;">
				${alert.headlines
					.map((h) => {
						const headline = escapeHtml(h.headline);
						const source = h.source ? escapeHtml(h.source) : "";
						return h.url
							? `<li style="margin-bottom: 6px;"><a href="${escapeHtml(h.url)}" style="color: #667eea; text-decoration: none;">${headline}</a>${source ? ` <span style="color: #9ca3af;">(${source})</span>` : ""}</li>`
							: `<li style="margin-bottom: 6px;">${headline}${source ? ` <span style="color: #9ca3af;">(${source})</span>` : ""}</li>`;
					})
					.join("\n\t\t\t\t")}
			</ul>
		</div>`
			: "";

	const aiSummaryHtml = alert.aiSummary
		? `
		<div style="margin-top: 16px; padding: 12px 16px; background: #f9fafb; border-radius: 6px; border-left: 3px solid #f59e0b;">
			<p style="color: #4b5563; font-size: 14px; margin: 0; font-style: italic;">${escapeHtml(alert.aiSummary)}</p>
		</div>`
		: "";

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Asset Price Alert</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">${escapeHtml(alert.symbol)}</h2>
		<div style="background: #fffbeb; padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #fde68a;">
			<p style="color: #92400e; font-size: 16px; font-weight: 500; margin: 0;">${escapeHtml(alert.priceContext)}</p>${renderHtmlSparkline(alert.intradayCloses)}
		</div>
		<div style="margin-bottom: 20px;">
			<p style="color: #6b7280; font-size: 14px; margin: 0;"><strong>Signals:</strong> ${escapeHtml(alert.signalContext)}</p>
		</div>
		${headlinesHtml}
		${aiSummaryHtml}
		<div style="text-align: center; margin-top: 30px;">
			<a href="${escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				View Dashboard →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
			<a href="${escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Manage alerts</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
		</p>
	</div>
</body>
</html>`;

	return { text, html };
}

/**
 * Deliver a price alert to a user via their preferred channels.
 */
export async function deliverPriceAlert(options: {
	user: PriceAlertUser;
	alert: EnrichedAlert;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	stats: PriceAlertDeliveryStats;
}): Promise<void> {
	const { user, alert, supabase, sendEmail, sendSms, stats } = options;

	// Email delivery
	if (user.market_asset_price_alerts_include_email) {
		const message = formatPriceAlertEmail(user, alert);
		const result = await sendUserEmail(
			user,
			`Alert: ${alert.symbol} price shock`,
			message,
			sendEmail,
		);

		if (result.success) {
			stats.emailsSent++;
		} else {
			stats.emailsFailed++;
		}

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "price_alert",
			delivery_method: "email",
			message_delivered: result.success,
			message: message.text,
			error: result.success ? undefined : result.error,
		});
		if (!logged) stats.logFailures++;
	}

	// SMS delivery
	if (user.market_asset_price_alerts_include_sms && sendSms) {
		if (!shouldSendSms(user)) {
			rootLogger.info("Price alert SMS skipped: user not eligible", {
				userId: user.id,
			});
			stats.smsFailed++;
		} else if (!user.phone_country_code || !user.phone_number) {
			rootLogger.warn("Price alert SMS skipped: no phone number", {
				userId: user.id,
			});
			stats.smsFailed++;
		} else {
			const smsBody = formatPriceAlertSms(alert);
			const result = await sendUserSms(user, smsBody, sendSms);

			if (result.success) {
				stats.smsSent++;
			} else {
				stats.smsFailed++;
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "price_alert",
				delivery_method: "sms",
				message_delivered: result.success,
				message: smsBody,
				error: result.success ? undefined : result.error,
			});
			if (!logged) stats.logFailures++;
		}
	}
}
