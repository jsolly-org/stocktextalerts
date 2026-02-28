import type { DateTime } from "luxon";
import {
	getUsMarketClosureInfoForInstant,
	type MarketClosureReason,
} from "./market-calendar";
import { calculateNextSendAtFromTimes } from "./scheduled-times";

const MAX_CANDIDATE_ITERATIONS = 400;

interface NextMarketScheduledSendResult {
	nextSendAt: DateTime | null;
	delayReasons: MarketClosureReason[];
	/** Name of the first holiday encountered (e.g. "Presidents' Day"), if available. */
	holidayName?: string;
}

/**
 * Compute the next scheduled send time that lands on an open US market day.
 */
export async function calculateNextMarketScheduledSendAtFromTimes(options: {
	localMinutesList: number[];
	timezone: string;
	now: DateTime;
}): Promise<NextMarketScheduledSendResult> {
	const { localMinutesList, timezone, now } = options;
	let cursor = now;
	const delayReasonSet = new Set<MarketClosureReason>();
	let holidayName: string | undefined;

	for (let i = 0; i < MAX_CANDIDATE_ITERATIONS; i++) {
		const candidate = calculateNextSendAtFromTimes(
			localMinutesList,
			timezone,
			cursor,
		);
		if (!candidate) {
			return {
				nextSendAt: null,
				delayReasons: [...delayReasonSet],
				holidayName,
			};
		}

		const closure = await getUsMarketClosureInfoForInstant(candidate);
		if (!closure) {
			return {
				nextSendAt: candidate,
				delayReasons: [...delayReasonSet],
				holidayName,
			};
		}

		delayReasonSet.add(closure.reason);
		if (!holidayName && closure.holidayName) {
			holidayName = closure.holidayName;
		}
		cursor = candidate.plus({ seconds: 1 });
	}

	return { nextSendAt: null, delayReasons: [...delayReasonSet], holidayName };
}
