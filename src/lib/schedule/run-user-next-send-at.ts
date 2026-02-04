import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import { calculateNextSendAtFromTimes } from "../time/digest-times";
import type { SupabaseAdminClient } from "./helpers";

export async function updateUserNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	const { user, supabase, logger, currentTime } = options;

	// Query filters out null daily_digest_notification_times with .not()
	const digestTimes = user.daily_digest_notification_times as number[];
	const nextSendAt = calculateNextSendAtFromTimes(
		digestTimes,
		user.timezone,
		currentTime,
	);
	const nextSendAtIso = nextSendAt ? nextSendAt.toISO() : null;
	if (nextSendAt && !nextSendAtIso) {
		logger.error("Failed to format next_send_at ISO string", {
			userId: user.id,
			timezone: user.timezone,
		});
	}
	if (!nextSendAt) {
		logger.warn("calculateNextSendAtFromTimes returned null", {
			userId: user.id,
			daily_digest_notification_times: user.daily_digest_notification_times,
			timezone: user.timezone,
		});
	}

	const { error: updateError } = await supabase
		.from("users")
		.update({ next_send_at: nextSendAtIso })
		.eq("id", user.id);

	if (updateError) {
		logger.error(
			nextSendAtIso
				? "Failed to update users.next_send_at"
				: "Failed to clear users.next_send_at",
			{
				userId: user.id,
				nextSendAt: nextSendAtIso ?? undefined,
			},
			updateError,
		);
	}
}
