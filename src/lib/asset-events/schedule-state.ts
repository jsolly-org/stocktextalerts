import type { SupabaseAdminClient } from "../db/supabase";
import { shouldAdvanceScheduledNotificationSchedule } from "../schedule/delivery-terminal";
import type { ScheduledSlotKey, UserRecord } from "../types";

/** True when every enabled asset-events channel is terminal for this slot. */
export async function shouldAdvanceAssetEventsSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		emailRequired: boolean;
		smsRequired: boolean;
		telegramRequired?: boolean;
	} & ScheduledSlotKey,
): Promise<boolean> {
	return shouldAdvanceScheduledNotificationSchedule({
		...options,
		notificationType: "asset_events",
	});
}
