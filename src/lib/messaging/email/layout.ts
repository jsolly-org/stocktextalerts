import { DASHBOARD_SECTION_HASHES } from "../../constants";
import { getSiteUrl } from "../../db/env";
import { NOT_FINANCIAL_ADVICE } from "../constants";
import { escapeHtml } from "../parts/html-utils";
import { createEmailUnsubscribeUrl } from "./unsubscribe";

/** Precomputed URLs used in email templates (both raw and HTML-escaped). */
interface EmailUrls {
	dashboardUrl: string;
	escapedDashboardUrl: string;
	scheduleUrl: string;
	escapedScheduleUrl: string;
	unsubscribeUrl: string;
	escapedUnsubscribeUrl: string;
}

/** Dashboard section keys used to build schedule/deep-link URLs in emails. */
type DashboardSection = keyof typeof DASHBOARD_SECTION_HASHES;

/**
 * Build all standard email URLs (dashboard, schedule section, unsubscribe) and
 * their HTML-escaped counterparts for safe embedding in email templates.
 */
export function buildEmailUrls(
	userId: string,
	email: string,
	sectionHash: DashboardSection,
): EmailUrls {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const escapedDashboardUrl = escapeHtml(dashboardUrl);
	const scheduleUrl = `${dashboardUrl}${DASHBOARD_SECTION_HASHES[sectionHash]}`;
	const escapedScheduleUrl = escapeHtml(scheduleUrl);
	const unsubscribeUrl = createEmailUnsubscribeUrl({ userId, email });
	const escapedUnsubscribeUrl = escapeHtml(unsubscribeUrl);
	return {
		dashboardUrl,
		escapedDashboardUrl,
		scheduleUrl,
		escapedScheduleUrl,
		unsubscribeUrl,
		escapedUnsubscribeUrl,
	};
}

/**
 * Render the shared email footer containing schedule and unsubscribe links.
 */
export function renderEmailFooter(urls: EmailUrls): string {
	return `<p style="color: #6b7280; font-size: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
			<a href="${urls.escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Adjust delivery schedule</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${urls.escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
			<br />${escapeHtml(NOT_FINANCIAL_ADVICE)}
		</p>`;
}

const EMAIL_SHELL_HEADER_GRADIENT = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";

/** Render a filled CTA button matching the welcome-email style. */
export function renderEmailButton(href: string, label: string): string {
	const escapedHref = escapeHtml(href);
	return `<div style="text-align: center; margin: 36px 0;">
		<a href="${escapedHref}" style="display: inline-block; background: #667eea; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px;">
			${escapeHtml(label)}
		</a>
	</div>`;
}

/** Render the shared welcome-email HTML document shell. */
export function renderEmailShell(options: { bodyHtml: string; footerHtml?: string }): string {
	const { bodyHtml, footerHtml = "" } = options;
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="color-scheme" content="light">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: ${EMAIL_SHELL_HEADER_GRADIENT}; padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 StockTextAlerts</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${bodyHtml}
		${footerHtml}
	</div>
</body>
</html>`;
}
