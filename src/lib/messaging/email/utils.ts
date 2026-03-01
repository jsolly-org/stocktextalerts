import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { rootLogger } from "../../logging";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { escapeHtml, formatAssetsHtmlList } from "../asset-formatting";
import {
	buildMarketClosedBannerHtml,
	buildMarketClosedBannerText,
} from "../market-closure-banner";
import type { SparklineData } from "../sparkline";
import type {
	DeliveryResult,
	EmailUser,
	FormatPreferences,
	UserAssetRow,
} from "../types";

import { buildEmailUrls } from "./layout";

interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
	replyTo?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;

/** Create an AWS SES-backed email sender (mocked in test mode). */
export function createEmailSender(): EmailSender {
	const fromEmail = import.meta.env.EMAIL_FROM;
	const defaultReplyTo = import.meta.env.EMAIL_REPLY_TO;

	// In test mode, return a mock sender unless --live=email is set.
	// LIVE_API_PROVIDERS is set by run-vitest.ts before Vitest starts, making it
	// visible in source code (unlike vi.stubEnv which only affects test context).
	const liveProviders = import.meta.env.LIVE_API_PROVIDERS || "";
	const liveEmail =
		liveProviders === "all" ||
		liveProviders
			.split(",")
			.map((s: string) => s.trim())
			.includes("email");
	if (import.meta.env.MODE === "test" && !liveEmail) {
		return async () => ({
			success: true,
			messageSid: "test",
		});
	}

	const ses = new SESv2Client({ region: import.meta.env.AWS_REGION });

	return async ({ to, subject, body, html, replyTo }) => {
		try {
			const replyToValue = replyTo || defaultReplyTo;
			const command = new SendEmailCommand({
				FromEmailAddress: fromEmail,
				Destination: { ToAddresses: [to] },
				ReplyToAddresses: replyToValue ? [replyToValue] : undefined,
				Content: {
					Simple: {
						Subject: { Data: subject, Charset: "UTF-8" },
						Body: {
							Text: { Data: body, Charset: "UTF-8" },
							Html: { Data: html ?? escapeHtml(body), Charset: "UTF-8" },
						},
					},
				},
			});

			const response = await ses.send(command);
			return { success: true, messageSid: response.MessageId };
		} catch (error) {
			rootLogger.error(
				"SES error sending email",
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
	getSparkline?: (symbol: string) => SparklineData | null | undefined,
	marketClosureInfo?: MarketClosureInfo | null,
): { text: string; html: string } {
	const urls = buildEmailUrls(user.id, user.email, "marketNotifications");
	const textFooter = `\n\nManage your delivery schedule: ${urls.scheduleUrl}\nUnsubscribe from all emails: ${urls.unsubscribeUrl}`;
	const htmlFooter = `
		<p style="color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
			<a href="${urls.escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Adjust delivery schedule</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${urls.escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
		</p>`;

	if (userAssets.length === 0) {
		const text = `You don't have any tracked assets yet.\n\nVisit your dashboard to add assets to track: ${urls.dashboardUrl}${textFooter}`;
		const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Scheduled Price Update</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Get Started Tracking Assets</h2>
		<p style="color: #4b5563; font-size: 16px; margin-bottom: 30px;">
			You don't have any tracked assets yet. Start tracking your favorite assets to receive regular updates!
		</p>
		<div style="text-align: center; margin: 40px 0;">
			<a href="${urls.escapedDashboardUrl}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px; transition: background 0.2s;">
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
		: `\n${buildMarketClosedBannerText(marketClosureInfo ?? null)}\n`;
	const text = `Your tracked assets:\n${marketDisclaimer}${assetsList}${textFooter}`;
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
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Scheduled Price Update</h1>
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
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your settings →
			</a>
		</div>
		${htmlFooter}
	</div>
</body>
</html>`;

	return { text, html };
}
