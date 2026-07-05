/**
 * Delay banner utilities for notifications sent after their scheduled time.
 *
 * When the system experiences downtime or API issues and must "catch up" on
 * missed notifications, these helpers detect the delay and produce a banner
 * that is prepended to the notification so the user knows it arrived late.
 */

import type { MessageEntity } from "grammy/types";
import { DateTime } from "luxon";
import { escapeHtml } from "./html-utils";

/** Notifications delayed by less than this threshold are considered on-time. */
export const DELAY_THRESHOLD_MINUTES = 5;

/** Detect whether a notification is delayed beyond the threshold. */
export function getDelayMinutes(scheduledFor: DateTime, now: DateTime): number {
	const diffMinutes = now.diff(scheduledFor, "minutes").minutes;
	return Math.max(0, Math.floor(diffMinutes));
}

/** Format the scheduled time in the user's timezone for display. */
function formatScheduledTime(
	scheduledFor: DateTime,
	userTimezone: string,
	use24Hour: boolean,
): string {
	const local = scheduledFor.setZone(userTimezone);
	if (!local.isValid) {
		return scheduledFor.toLocaleString(DateTime.TIME_SIMPLE);
	}
	const tz = local.toFormat("ZZZZ"); // e.g. "EDT", "PST"
	if (use24Hour) {
		return `${local.toLocaleString(DateTime.TIME_24_SIMPLE)} ${tz}`;
	}
	return `${local.toLocaleString({ ...DateTime.TIME_SIMPLE, hourCycle: "h12" })} ${tz}`;
}

/** Build a plain-text delay banner for email text. Returns null if not delayed. */
export function buildDelayBannerText(options: {
	scheduledFor: DateTime;
	now: DateTime;
	userTimezone: string;
	use24Hour: boolean;
}): string | null {
	const delayMinutes = getDelayMinutes(options.scheduledFor, options.now);
	if (delayMinutes < DELAY_THRESHOLD_MINUTES) {
		return null;
	}
	const time = formatScheduledTime(options.scheduledFor, options.userTimezone, options.use24Hour);
	return `⏰ Delayed — originally scheduled for ${time}.`;
}

/** Build an HTML delay banner for email. Returns empty string if not delayed. */
export function buildDelayBannerHtml(options: {
	scheduledFor: DateTime;
	now: DateTime;
	userTimezone: string;
	use24Hour: boolean;
}): string {
	const delayMinutes = getDelayMinutes(options.scheduledFor, options.now);
	if (delayMinutes < DELAY_THRESHOLD_MINUTES) {
		return "";
	}
	const time = escapeHtml(
		formatScheduledTime(options.scheduledFor, options.userTimezone, options.use24Hour),
	);
	return `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; text-align: center;">
			<div style="font-size: 14px; color: #92400e; font-weight: 600;">⏰ Delayed Notification</div>
			<div style="font-size: 12px; color: #92400e; margin-top: 4px;">This was originally scheduled for ${time}.</div>
		</div>`;
}

/**
 * Prepend a delay banner to pre-rendered email content.
 * For text: inserts after the first line.
 * For HTML: inserts the banner div after the opening content div.
 */
export function prependDelayBannerToEmail(
	text: string,
	html: string,
	bannerText: string,
	bannerHtml: string,
): { text: string; html: string } {
	const firstNewline = text.indexOf("\n");
	const newText =
		firstNewline === -1
			? `${bannerText}\n${text}`
			: `${text.slice(0, firstNewline)}\n${bannerText}${text.slice(firstNewline)}`;

	// Inject HTML banner after the content div opening (border-radius: 0 0 8px 8px)
	const contentDivMarker = "border-radius: 0 0 8px 8px;";
	const markerIdx = html.indexOf(contentDivMarker);
	let newHtml = html;
	if (markerIdx !== -1) {
		const closingBracket = html.indexOf(">", markerIdx);
		if (closingBracket !== -1) {
			newHtml = `${html.slice(0, closingBracket + 1)}\n\t\t${bannerHtml}${html.slice(closingBracket + 1)}`;
		}
	}

	return { text: newText, html: newHtml };
}

/** Prepend a delay banner to pre-rendered Telegram content (plain banner, shift entity offsets). */
export function prependDelayBannerToTelegram(
	text: string,
	entities: MessageEntity[],
	bannerText: string,
): { text: string; entities: MessageEntity[] } {
	const firstNewline = text.indexOf("\n\n");
	const insertAt = firstNewline === -1 ? text.length : firstNewline;
	const insertion = firstNewline === -1 ? `\n\n${bannerText}` : `\n${bannerText}`;
	const shift = insertion.length;
	const newText = `${text.slice(0, insertAt)}${insertion}${text.slice(insertAt)}`;
	const newEntities = entities.map((entity) =>
		entity.offset >= insertAt ? { ...entity, offset: entity.offset + shift } : entity,
	);
	return { text: newText, entities: newEntities };
}
