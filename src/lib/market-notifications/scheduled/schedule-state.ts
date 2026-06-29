import { shouldAdvanceScheduledNotificationSchedule } from "../../schedule/delivery-terminal";
import type { SupabaseAdminClient } from "../../schedule/helpers";
import type { ScheduledSlotKey } from "../../types";
import type { UserRecord } from "../../user-record-types";

/** True when every enabled market-scheduled channel is terminal for this slot. */
export async function shouldAdvanceMarketScheduledSchedule(
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
		notificationType: "market",
	});
}
