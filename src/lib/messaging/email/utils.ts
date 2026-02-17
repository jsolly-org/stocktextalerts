import { Resend } from "resend";
import { DASHBOARD_SECTION_HASHES } from "../../constants";
import { getSiteUrl } from "../../db/env";
import { rootLogger } from "../../logging";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { escapeHtml, formatAssetsHtmlList } from "../asset-formatting";
import {
	buildMarketClosedBannerHtml,
	buildMarketClosedBannerText,
} from "../market-closure-banner";
import type {
	DeliveryResult,
	EmailUser,
	FormatPreferences,
	UserAssetRow,
} from "../types";
import { createEmailUnsubscribeUrl } from "./unsubscribe";

interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
	idempotencyKey?: string;
	replyTo?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;

/** Create a Resend-backed email sender (mocked in test mode). */
export function createEmailSender(): EmailSender {
	const apiKey = import.meta.env.RESEND_API_KEY;
	const fromEmail = import.meta.env.EMAIL_FROM;
	const defaultReplyTo = import.meta.env.EMAIL_REPLY_TO;

	// In test mode, return a mock sender that always succeeds without making API calls
	if (import.meta.env.MODE === "test") {
		return async () => ({
			success: true,
			messageSid: "test",
		});
	}

	if (!apiKey.startsWith("re_")) {
		rootLogger.warn(
			"RESEND_API_KEY has invalid format. Expected key starting with 're_'.",
			{ action: "create_email_sender" },
		);
		return async () => ({
			success: false,
			error: "RESEND_API_KEY has invalid format",
		});
	}

	const resend = new Resend(apiKey);

	return async ({ to, subject, body, html, idempotencyKey, replyTo }) => {
		try {
			const replyToValue = replyTo || defaultReplyTo;
			const emailPayload = {
				from: fromEmail,
				to,
				subject,
				text: body,
				html: html ?? escapeHtml(body),
				...(replyToValue ? { replyTo: replyToValue } : {}),
			};
			const sendOptions = idempotencyKey ? { idempotencyKey } : undefined;
			const { data, error } = await resend.emails.send(
				emailPayload,
				sendOptions,
			);

			if (error) {
				// Resend SDK returns structured errors with 'type' field for error codes.
				// Common error types: 'validation_error', 'invalid_api_key', 'rate_limit_exceeded',
				// 'monthly_quota_exceeded', 'daily_quota_exceeded', 'invalid_from_address', etc.
				// Error objects also have 'message' and 'status' fields.
				const err = error as {
					type?: string;
					message?: string;
					status?: number;
				};
				rootLogger.error("Resend error", {
					type: err.type,
					message: err.message,
					status: err.status,
				});
				const errorMessage =
					typeof err.message === "string"
						? err.message
						: "Failed to send email";
				return { success: false, error: errorMessage };
			}

			return { success: true, messageSid: data?.id };
		} catch (error) {
			rootLogger.error(
				"Unexpected error sending email",
				{ action: "send_email_notification" },
				error,
			);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};
}

/** Build the plaintext + HTML email body for a scheduled asset update. */
export function formatEmailMessage(
	user: EmailUser,
	userAssets: UserAssetRow[],
	assetsList: string,
	priceMap: AssetPriceMap,
	marketOpen: boolean,
	formatPrefs?: FormatPreferences,
	getSparkline?: (symbol: string) => string | null | undefined,
	marketClosureInfo?: MarketClosureInfo | null,
): { text: string; html: string } {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const escapedDashboardUrl = escapeHtml(dashboardUrl);
	const scheduleUrl = `${dashboardUrl}${DASHBOARD_SECTION_HASHES.marketNotifications}`;
	const escapedScheduleUrl = escapeHtml(scheduleUrl);
	const unsubscribeUrl = createEmailUnsubscribeUrl({
		userId: user.id,
		email: user.email,
	});
	const escapedUnsubscribeUrl = escapeHtml(unsubscribeUrl);
	const textFooter = `\n\nManage your delivery schedule: ${scheduleUrl}\nUnsubscribe: ${unsubscribeUrl}`;
	const htmlFooter = `
		<p style="color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
			<a href="${escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Adjust delivery schedule</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe</a>
		</p>`;

	if (userAssets.length === 0) {
		const text = `You don't have any tracked assets yet.\n\nVisit your dashboard to add assets to track: ${dashboardUrl}${textFooter}`;
		const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 StockTextAlerts</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Get Started Tracking Assets</h2>
		<p style="color: #4b5563; font-size: 16px; margin-bottom: 30px;">
			You don't have any tracked assets yet. Start tracking your favorite assets to receive regular updates!
		</p>
		<div style="text-align: center; margin: 40px 0;">
			<a href="${escapedDashboardUrl}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px; transition: background 0.2s;">
				Add Assets to Track →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 30px; border-top: 1px solid #e5e7eb;">
			Once you add assets to your dashboard, you'll receive regular updates about them during your configured notification window.
		</p>
		${htmlFooter}
	</div>
</body>
</html>`;
		return { text, html };
	}

	const marketDisclaimer = marketOpen
		? ""
		: `\n${buildMarketClosedBannerText(marketClosureInfo ?? null)}`;
	const text = `Your tracked assets:\n${assetsList}${marketDisclaimer}${textFooter}`;
	const escapedAssetsListHtml = formatAssetsHtmlList(
		userAssets,
		(symbol) => priceMap.get(symbol) ?? undefined,
		formatPrefs ?? { show_sparklines: false },
		getSparkline,
	);
	const marketClosedBannerHtml = marketOpen
		? ""
		: buildMarketClosedBannerHtml(marketClosureInfo ?? null);
	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 StockTextAlerts</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${marketClosedBannerHtml}
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Your Scheduled Price Notification</h2>
		<div style="background: #f9fafb; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
			<p style="color: #1f2937; font-size: 18px; font-weight: 600; margin: 0; font-family: 'Courier New', monospace;">
				${escapedAssetsListHtml}
			</p>
		</div>
		<div style="text-align: center; margin-top: 30px;">
			<a href="${escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your settings →
			</a>
		</div>
		${htmlFooter}
	</div>
</body>
</html>`;

	return { text, html };
}
