import type { SupabaseAdminClient } from "../db/supabase";
import { shouldAdvanceScheduledNotificationSchedule } from "../schedule/delivery-terminal";
import type { DeliveryMethod } from "../scheduled-notifications/types";
import type { ScheduledSlotKey, UserRecord } from "../types";

/** True when the account's outbound channel is terminal for this asset-events slot. */
export async function shouldAdvanceAssetEventsSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		requiredChannel: DeliveryMethod | null;
	} & ScheduledSlotKey,
): Promise<boolean> {
	return shouldAdvanceScheduledNotificationSchedule({
		...options,
		notificationType: "asset_events",
	});
}
