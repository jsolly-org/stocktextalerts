/**
 * Staged notification data types.
 *
 * These represent fully rendered, ready-to-send notification content stored in
 * the `staged_notifications` table. No merging or formatting happens at delivery time.
 */

import type { MessageEntity } from "grammy/types";
import type { StagedNotificationType } from "../db";
import type { IsoTimestampString, ScheduledSlotKey, YearMonthString } from "../types";

export type { StagedNotificationType };

interface StagedEmailContent {
	subject: string;
	text: string;
	html: string;
}

export type StagedSmsContent =
	| { messages: string[] }
	// Short-lived persisted JSON compatibility for rows staged before multipart SMS shipped.
	| { message: string };

/** Fully-rendered Telegram message: plain text plus out-of-band parse-mode entities. */
interface StagedTelegramContent {
	text: string;
	entities: MessageEntity[];
}

export interface StagedDailyData extends ScheduledSlotKey {
	type: "daily";
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

export interface StagedNotificationRow {
	id: string;
	user_id: string;
	notification_type: StagedNotificationType;
	scheduled_for: IsoTimestampString;
	staged_at: IsoTimestampString;
	staged_data: StagedData;
}
