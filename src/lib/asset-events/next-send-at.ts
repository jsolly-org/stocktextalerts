import type { DateTime } from "luxon";
import { updateUserDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { UserRecord } from "../types";

/** @deprecated Standalone asset-events cron removed; use {@link updateUserDailyNotificationNextSendAt}. */
export async function updateUserAssetEventsNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	return updateUserDailyNotificationNextSendAt(options);
}
