import type { MarketSession } from "../../market-data/types";
import { escapeHtml } from "../../messaging/asset-formatting";
import { formatMinutesAsLocalTime } from "../../time/format";

/** Active market session for which a notification is delivered. Closed users
 * are skipped before the renderer is reached, so this type narrows accordingly. */
export type ActiveMarketSession = Exclude<MarketSession, "closed">;

/**
 * Build the session-aware first body line shown in scheduled-market notifications.
 *
 * Renders a short label like "Pre-market — 7:00 AM ET" so the recipient can
 * quickly distinguish pre/regular/after-hours quotes.
 */
export function buildSessionFirstLine(
	session: ActiveMarketSession,
	scheduledEtMinutes: number,
	is24: boolean,
): string {
	const timeLabel = formatMinutesAsLocalTime(scheduledEtMinutes, is24);
	switch (session) {
		case "pre":
			return `Pre-market — ${timeLabel} ET`;
		case "regular":
			return `Regular hours — ${timeLabel} ET`;
		case "after":
			return `After-hours — ${timeLabel} ET`;
	}
}

/**
 * HTML version of the session-aware first body line. Uses an explicit
 * dark-slate color (#0f172a) on the inherited light email background to
 * satisfy WCAG SC 1.4.3 4.5:1 contrast.
 */
export function buildSessionFirstLineHtml(
	session: ActiveMarketSession,
	scheduledEtMinutes: number,
	is24: boolean,
): string {
	const text = buildSessionFirstLine(session, scheduledEtMinutes, is24);
	return `<p style="font-weight: bold; color: #0f172a; margin: 0 0 16px;">${escapeHtml(text)}</p>`;
}
