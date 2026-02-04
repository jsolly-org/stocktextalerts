import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import { toIsoOrThrow } from "../time/format";
import {
	type ScheduledNotificationTotals,
	type SupabaseAdminClient,
	USER_PROCESS_BATCH_SIZE,
} from "./helpers";
import { fetchScheduledUsers } from "./run-query";
import { processScheduledUser } from "./run-user";
import { createSmsSenderProvider } from "./run-user-sms-sender";

async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	now?: DateTime;
}): Promise<ScheduledNotificationTotals> {
	const { supabase, logger, forceSend } = options;
	const sendEmail = createEmailSender();

	const currentTime = options.now ?? DateTime.utc();
	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format UTC ISO string",
	);
	const users = await fetchScheduledUsers({
		supabase,
		forceSend,
		currentTimeIso,
	});

	const getSmsSender = createSmsSenderProvider(logger);

	const results: ScheduledNotificationTotals[] = [];
	for (let index = 0; index < users.length; index += USER_PROCESS_BATCH_SIZE) {
		const batch = users.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processScheduledUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
				}),
			),
		);
		results.push(...batchResults);
	}

	return results.reduce(
		(acc, curr) => ({
			skipped: acc.skipped + curr.skipped,
			logFailures: acc.logFailures + curr.logFailures,
			emailsSent: acc.emailsSent + curr.emailsSent,
			emailsFailed: acc.emailsFailed + curr.emailsFailed,
			smsSent: acc.smsSent + curr.smsSent,
			smsFailed: acc.smsFailed + curr.smsFailed,
		}),
		{
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		},
	);
}

export { runScheduledNotifications };
