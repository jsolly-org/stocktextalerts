import { DASHBOARD_SECTION_HASHES } from "../../constants";
import { getSiteUrl } from "../../db/env";
import { escapeHtml } from "../stock-formatting";
import { createEmailUnsubscribeUrl } from "./email-unsubscribe";

export interface EmailUrls {
	dashboardUrl: string;
	escapedDashboardUrl: string;
	scheduleUrl: string;
	escapedScheduleUrl: string;
	unsubscribeUrl: string;
	escapedUnsubscribeUrl: string;
}

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
			<a href="${urls.escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from email</a>
		</p>`;
}
