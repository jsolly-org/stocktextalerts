/**
 * Staged notification data types.
 *
 * These represent fully rendered, ready-to-send notification content stored in
 * the `staged_notifications` table. No merging or formatting happens at delivery time.
 */

import type { MessageEntity } from "grammy/types";
import type {
	IsoDateString,
	IsoTimestampString,
	MinuteOfDay,
	YearMonthString,
} from "../domain/types";

export interface StagedEmailContent {
	subject: string;
	text: string;
	html: string;
}

export type StagedSmsContent =
	| { messages: string[] }
	// Short-lived persisted JSON compatibility for rows staged before multipart SMS shipped.
	| { message: string };

/** Fully-rendered Telegram message: plain text plus out-of-band parse-mode entities. */
export interface StagedTelegramContent {
	text: string;
	entities: MessageEntity[];
}

export interface StagedDailyData {
	type: "daily";
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	email: StagedEmailContent | null;
	sms: StagedSmsContent | null;
	telegram: StagedTelegramContent | null;

	// Post-delivery metadata: these fields capture decisions made during
	// the pre-compute phase so the delivery phase can perform cleanup
	// (Grok counter updates, next_send_at advances, analyst month tracking)
	// without re-running eligibility checks or re-querying user preferences.
	grokAllowed: boolean;
	hasAnyAssetEventsOption: boolean;
	shouldUpdateAnalyst: boolean;
	analystMonth: YearMonthString | null;
}

export type StagedData = StagedDailyData;

/** Matches app usage; DB CHECK still allows legacy `market` rows (unused). */
export type StagedNotificationType = "daily";

export interface StagedNotificationRow {
	id: string;
	user_id: string;
	notification_type: StagedNotificationType;
	scheduled_for: IsoTimestampString;
	staged_at: IsoTimestampString;
	staged_data: StagedData;
}
