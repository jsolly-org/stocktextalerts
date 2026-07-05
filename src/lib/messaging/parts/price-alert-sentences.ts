import type { PriceMoveFacts } from "../../price-alerts/types";
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
