import type { SupabaseAdminClient } from "../../db/supabase";
import { shouldAdvanceScheduledNotificationSchedule } from "../../schedule/delivery-terminal";
import type { DeliveryMethod } from "../../scheduled-notifications/types";
import type { ScheduledSlotKey, UserRecord } from "../../types";

/** True when the account's outbound channel is terminal for this market-scheduled slot. */
export async function shouldAdvanceMarketScheduledSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		requiredChannel: DeliveryMethod | null;
	} & ScheduledSlotKey,
): Promise<boolean> {
	return shouldAdvanceScheduledNotificationSchedule({
		...options,
		notificationType: "market",
	});
}
