import { getSiteUrl } from "../db/env";
import { rootLogger } from "../logging";
import type { ScheduledNotificationTotals } from "./helpers";

const DISPATCH_TIMEOUT_MS = 120_000;

const EMPTY_STATS: ScheduledNotificationTotals = {
	skipped: 1,
	logFailures: 0,
	emailsSent: 0,
	emailsFailed: 0,
	smsSent: 0,
	smsFailed: 0,
};

export async function dispatchDailyUser(options: {
	userId: string;
	currentTimeIso: string;
	marketOpen: boolean;
	cronSecret: string;
}): Promise<ScheduledNotificationTotals> {
	const { userId, currentTimeIso, marketOpen, cronSecret } = options;
	const url = new URL("/api/schedule/daily-user", getSiteUrl()).toString();

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cronSecret}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ userId, currentTimeIso, marketOpen }),
			signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			rootLogger.error("Fan-out dispatch failed", {
				action: "dispatch_daily_user",
				userId,
				status: response.status,
				statusText: response.statusText,
			});
			return { ...EMPTY_STATS };
		}

		const data = (await response.json()) as ScheduledNotificationTotals;
		return data;
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "request_failed";
		rootLogger.error(
			"Fan-out dispatch errored",
			{ action: "dispatch_daily_user", userId, reason },
			error,
		);
		return { ...EMPTY_STATS };
	}
}
