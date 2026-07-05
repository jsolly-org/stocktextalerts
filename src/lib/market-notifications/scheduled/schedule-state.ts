import type { SupabaseAdminClient } from "../../db/supabase";
import { shouldAdvanceScheduledNotificationSchedule } from "../../schedule/delivery-terminal";
import type { ScheduledSlotKey, UserRecord } from "../../types";

/** True when every enabled market-scheduled channel is terminal for this slot. */
export async function shouldAdvanceMarketScheduledSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		emailRequired: boolean;
		telegramRequired?: boolean;
	} & ScheduledSlotKey,
): Promise<boolean> {
	return shouldAdvanceScheduledNotificationSchedule({
		...options,
		notificationType: "market",
	});
}
