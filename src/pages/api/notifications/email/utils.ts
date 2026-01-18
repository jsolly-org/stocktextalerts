import { Resend } from "resend";
import { getSiteUrl } from "../../../../lib/env";
import type { DeliveryResult, UserStockRow } from "../shared";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;

export function createEmailSender(): EmailSender {
	const apiKey = import.meta.env.RESEND_API_KEY;
	const fromEmail = import.meta.env.EMAIL_FROM;

	if (!apiKey) {
		console.warn("RESEND_API_KEY is not set. Emails will not be sent.");
		return async () => ({ success: false, error: "RESEND_API_KEY missing" });
	}

	if (!apiKey.startsWith("re_")) {
		console.warn(
			"RESEND_API_KEY has invalid format. Expected key starting with 're_'.",
		);
		return async () => ({
			success: false,
			error: "RESEND_API_KEY has invalid format",
		});
	}

	const resend = new Resend(apiKey);

	return async ({ to, subject, body, html }) => {
		try {
			const { data, error } = await resend.emails.send({
				from: fromEmail || "notifications@updates.stocktextalerts.com",
				to,
				subject,
				text: body,
				html: html ?? escapeHtml(body),
			});

			if (error) {
				console.error("Resend error:", error);
				return { success: false, error: error.message };
			}

			return { success: true, messageSid: data?.id };
		} catch (error) {
			console.error("Unexpected error sending email:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};
}

export function formatEmailMessage(
	userStocks: UserStockRow[],
	stocksList: string,
): { text: string; html: string } {
	const dashboardUrl = `${getSiteUrl()}/dashboard`;
	const escapedDashboardUrl = escapeHtml(dashboardUrl);

	if (userStocks.length === 0) {
		const text = `You don't have any tracked stocks yet.\n\nVisit your dashboard to add stocks to track: ${dashboardUrl}`;
		const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 Stock Text Alerts</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Get Started Tracking Stocks</h2>
		<p style="color: #4b5563; font-size: 16px; margin-bottom: 30px;">
			You don't have any tracked stocks yet. Start tracking your favorite stocks to receive regular updates!
		</p>
		<div style="text-align: center; margin: 40px 0;">
			<a href="${escapedDashboardUrl}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px; transition: background 0.2s;">
				Add Stocks to Track →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 30px; border-top: 1px solid #e5e7eb;">
			Once you add stocks to your dashboard, you'll receive regular updates about them during your configured notification window.
		</p>
	</div>
</body>
</html>`;
		return { text, html };
	}

	const text = `Your tracked stocks: ${stocksList}`;
	const escapedStocksList = escapeHtml(stocksList);
	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 Stock Text Alerts</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Your Stock Update</h2>
		<div style="background: #f9fafb; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
			<p style="color: #1f2937; font-size: 18px; font-weight: 600; margin: 0; font-family: 'Courier New', monospace;">
				${escapedStocksList}
			</p>
		</div>
		<div style="text-align: center; margin-top: 30px;">
			<a href="${escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your stocks →
			</a>
		</div>
	</div>
</body>
</html>`;

	return { text, html };
}
