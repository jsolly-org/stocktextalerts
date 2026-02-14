/**
 * Staged notification data types.
 *
 * These represent fully rendered, ready-to-send notification content stored in
 * the `staged_notifications` table. No merging or formatting happens at delivery time.
 */

export interface StagedEmailContent {
	subject: string;
	text: string;
	html: string;
}

export interface StagedMarketData {
	type: "market";
	scheduledDate: string;
	scheduledMinutes: number;
	marketOpen: boolean;
	email: StagedEmailContent | null;
	sms: { message: string } | null;
}

export interface StagedDailyData {
	type: "daily";
	scheduledDate: string;
	scheduledMinutes: number;
	email: StagedEmailContent | null;
	sms: { message: string } | null;

	// Post-delivery metadata: these fields capture decisions made during
	// the pre-compute phase so the delivery phase can perform cleanup
	// (Grok counter updates, next_send_at advances, analyst month tracking)
	// without re-running eligibility checks or re-querying user preferences.
	grokAllowed: boolean;
	hasAnyAssetEventsOption: boolean;
	shouldUpdateAnalyst: boolean;
	analystMonth: string | null;
}

export type StagedData = StagedMarketData | StagedDailyData;

export type StagedNotificationType = "market" | "daily";

export interface StagedNotificationRow {
	id: string;
	user_id: string;
	notification_type: StagedNotificationType;
	scheduled_for: string;
	staged_at: string;
	staged_data: StagedData;
}
