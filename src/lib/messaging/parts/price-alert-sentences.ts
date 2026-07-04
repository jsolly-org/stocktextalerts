import type { PriceMoveFacts, SignalFacts } from "../../price-alerts/types";
import { formatUsdPrice } from "./asset-price-list";

/**
 * Render a single-asset price-alert HEADLINE from structured facts
 * ("LDOS is down 11.1% today ($173.00)").
 *
 * Pure and browser-safe (no grammY / resvg runtime): the dashboard preview
 * imports this directly to render the Telegram channel's headline. Rounds
 * change% to 1 decimal for readability — deliberately coarser than the
 * 2-decimal precision on multi-asset price lines; the flat-alert subject
 * builder mirrors this convention. `period` covers re-trigger phrasing
 * ("since last alert").
 */
export function renderPriceAlertHeadline(facts: PriceMoveFacts): string {
	const direction = facts.changePercent >= 0 ? "up" : "down";
	return `${facts.symbol} is ${direction} ${Math.abs(facts.changePercent).toFixed(1)}% ${facts.period} (${formatUsdPrice(facts.price)})`;
}

/**
 * Render the user-facing SIGNAL sentence from structured facts — benchmark move
 * ("The broader market (SPY) moved up 0.85% today.") and/or earnings proximity.
 * Direction comes from `benchmarkMovePercent`'s sign, magnitude from its absolute
 * value. Returns "" only when the facts carry nothing to say; callers pass a
 * non-null `SignalFacts` (null signals are skipped upstream).
 */
export function renderSignalSentence(facts: SignalFacts): string {
	const market =
		facts.benchmarkMovePercent !== null
			? `The ${facts.benchmarkLabel} moved ${facts.benchmarkMovePercent >= 0 ? "up" : "down"} ${Math.abs(facts.benchmarkMovePercent).toFixed(2)}% today.`
			: null;
	const earnings = facts.hasEarningsNearby
		? "Earnings are expected within the next couple of days."
		: null;
	return [market, earnings].filter((value): value is string => value !== null).join(" ");
}
