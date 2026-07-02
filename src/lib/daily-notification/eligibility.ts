/* =============
Daily notification eligibility — one logical slot, many content facets.
============= */

import { enabledFacets, isFacetEnabled } from "../messaging/notification-prefs";
import type {
	AssetEventsContent,
	DailyDigestContent,
	DailyNotificationContent,
	PrefChannel,
	PrefRow,
} from "../types";
import { DAILY_NOTIFICATION_PREFERENCE_TYPE } from "./constants";

const DAILY_DIGEST_FACETS = [
	"prices",
	"top_movers",
	"news",
	"rumors",
] as const satisfies readonly DailyDigestContent[];

const DAILY_ASSET_EVENT_FACETS = [
	"calendar",
	"ipo",
	"analyst",
	"insider",
] as const satisfies readonly AssetEventsContent[];

export const DAILY_NOTIFICATION_FACETS = [
	...DAILY_DIGEST_FACETS,
	...DAILY_ASSET_EVENT_FACETS,
] as const satisfies readonly DailyNotificationContent[];

/** True when a daily notification facet is enabled on a channel. */
export function isDailyNotificationFacetEnabled(
	prefs: readonly PrefRow[],
	channel: PrefChannel,
	content: DailyNotificationContent,
): boolean {
	return isFacetEnabled(prefs, DAILY_NOTIFICATION_PREFERENCE_TYPE, channel, content);
}

/** Enabled daily notification content facets for a channel. */
export function enabledDailyNotificationFacets(
	prefs: readonly PrefRow[],
	channel: PrefChannel,
): Set<DailyNotificationContent> {
	return enabledFacets(
		prefs,
		DAILY_NOTIFICATION_PREFERENCE_TYPE,
		channel,
	) as Set<DailyNotificationContent>;
}

/** True when any daily notification facet is enabled on any channel. */
export function hasAnyDailyNotificationFacet(prefs: readonly PrefRow[]): boolean {
	return prefs.some((p) => p.notification_type === DAILY_NOTIFICATION_PREFERENCE_TYPE && p.enabled);
}

/** True when any asset-event facet is enabled on any channel. */
export function hasAnyDailyAssetEventFacet(prefs: readonly PrefRow[]): boolean {
	for (const content of DAILY_ASSET_EVENT_FACETS) {
		for (const channel of ["email", "sms", "telegram"] as const) {
			if (isDailyNotificationFacetEnabled(prefs, channel, content)) {
				return true;
			}
		}
	}
	return false;
}

/** True when any asset-event facet is enabled on a channel. */
export function anyDailyAssetEventFacetEnabled(
	prefs: readonly PrefRow[],
	channel: PrefChannel,
): boolean {
	for (const content of DAILY_ASSET_EVENT_FACETS) {
		if (isDailyNotificationFacetEnabled(prefs, channel, content)) {
			return true;
		}
	}
	return false;
}
