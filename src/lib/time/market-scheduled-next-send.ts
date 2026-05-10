import type { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { getUsMarketClosureInfoForInstant, type MarketClosureReason } from "./market-calendar";
import { calculateNextSendAtFromTimes } from "./scheduled-times";

const MAX_CANDIDATE_ITERATIONS = 400;

type DstShift = "spring-forward" | "fall-back";

interface NextMarketScheduledSendResult {
	nextSendAt: DateTime | null;
	delayReasons: MarketClosureReason[];
	/** Name of the first holiday encountered (e.g. "Presidents' Day"), if available. */
	holidayName?: string;
	/**
	 * Set when a US DST transition occurs strictly between `now` and `nextSendAt`.
	 * Lets the UI explain the wall-clock shift users on non-ET-aligned timezones
	 * will perceive across the gap. `null` when no transition straddles the window.
	 */
	dstShift: DstShift | null;
}

/**
 * Detect whether a US DST transition occurs between two instants.
 * Returns `"spring-forward"` if ET moved EST → EDT (offset increased),
 * `"fall-back"` if ET moved EDT → EST (offset decreased), `null` otherwise.
 */
function detectUsDstShiftBetween(from: DateTime, to: DateTime): DstShift | null {
	if (to <= from) return null;
	const fromOffset = from.setZone(US_MARKET_TIMEZONE).offset;
	const toOffset = to.setZone(US_MARKET_TIMEZONE).offset;
	if (fromOffset === toOffset) return null;
	return toOffset > fromOffset ? "spring-forward" : "fall-back";
}

/**
 * Compute the next scheduled send time that lands on an open US market day.
 */
export async function calculateNextMarketScheduledSendAtFromTimes(options: {
	etMinutesList: number[];
	now: DateTime;
}): Promise<NextMarketScheduledSendResult> {
	const { etMinutesList, now } = options;
	let cursor = now;
	const delayReasonSet = new Set<MarketClosureReason>();
	let holidayName: string | undefined;

	for (let i = 0; i < MAX_CANDIDATE_ITERATIONS; i++) {
		const candidate = calculateNextSendAtFromTimes(etMinutesList, cursor);
		if (!candidate) {
			return {
				nextSendAt: null,
				delayReasons: [...delayReasonSet],
				holidayName,
				dstShift: null,
			};
		}

		const closure = await getUsMarketClosureInfoForInstant(candidate);
		if (!closure) {
			return {
				nextSendAt: candidate,
				delayReasons: [...delayReasonSet],
				holidayName,
				dstShift: detectUsDstShiftBetween(now, candidate),
			};
		}

		delayReasonSet.add(closure.reason);
		if (!holidayName && closure.holidayName) {
			holidayName = closure.holidayName;
		}
		cursor = candidate.plus({ seconds: 1 });
	}

	return {
		nextSendAt: null,
		delayReasons: [...delayReasonSet],
		holidayName,
		dstShift: null,
	};
}
