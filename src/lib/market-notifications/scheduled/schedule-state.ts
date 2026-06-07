import type { UserRecord } from "../../messaging/types";
import { shouldAdvanceScheduledNotificationSchedule } from "../../schedule/delivery-terminal";
import type { SupabaseAdminClient } from "../../schedule/helpers";

/** True when every enabled market-scheduled channel is terminal for this slot. */
export async function shouldAdvanceMarketScheduledSchedule(options: {
	supabase: SupabaseAdminClient;
	user: UserRecord;
	scheduledDate: string;
	scheduledMinutes: number;
	emailRequired: boolean;
	smsRequired: boolean;
}): Promise<boolean> {
	return shouldAdvanceScheduledNotificationSchedule({
		...options,
		notificationType: "market",
	});
}
