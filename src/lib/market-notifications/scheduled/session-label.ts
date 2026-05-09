import { escapeHtml } from "../../messaging/asset-formatting";
import type { MarketSession } from "../../providers/price-fetcher";
import { formatMinutesAsLocalTime } from "../../time/format";

/** Active market session for which a notification is delivered. Closed users
 * are skipped before the renderer is reached, so this type narrows accordingly. */
export type ActiveMarketSession = Exclude<MarketSession, "closed">;

/**
 * Build the session-aware first body line shown in scheduled-market notifications.
 *
 * Renders a short label like "Pre-market — 7:00 AM ET" so the recipient can
 * quickly distinguish pre/regular/after-hours quotes. After-hours optionally
 * appends a "vs. 4:00 PM close $X" anchor when the prior regular-session
 * close is available.
 */
export function buildSessionFirstLine(
	session: ActiveMarketSession,
	scheduledEtMinutes: number,
	is24: boolean,
	priorRegularClose: number | null,
): string {
	const timeLabel = formatMinutesAsLocalTime(scheduledEtMinutes, is24);
	switch (session) {
		case "pre":
			return `Pre-market — ${timeLabel} ET`;
		case "regular":
			return `Regular hours — ${timeLabel} ET`;
		case "after": {
			const closeAnchor =
				priorRegularClose !== null && priorRegularClose !== 0
					? ` (vs. 4:00 PM close $${priorRegularClose.toFixed(2)})`
					: "";
			return `After-hours — ${timeLabel} ET${closeAnchor}`;
		}
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
	priorRegularClose: number | null,
): string {
	const text = buildSessionFirstLine(session, scheduledEtMinutes, is24, priorRegularClose);
	return `<p style="font-weight: bold; color: #0f172a; margin: 0 0 16px;">${escapeHtml(text)}</p>`;
}
