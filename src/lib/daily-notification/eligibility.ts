/* =============
Daily notification eligibility — one logical slot, many content facets.
============= */

import type { DailyNotificationContent } from "../constants";
import { anyFacetEnabled, enabledFacets, isFacetEnabled } from "../messaging/notification-prefs";
import type { PrefRow } from "../types";
import { DAILY_ASSET_EVENT_FACETS, DAILY_NOTIFICATION_PREFERENCE_TYPE } from "./constants";

/** True when a daily notification facet is enabled. */
export function isDailyNotificationFacetEnabled(
	prefs: readonly PrefRow[],
	content: DailyNotificationContent,
): boolean {
	return isFacetEnabled(prefs, DAILY_NOTIFICATION_PREFERENCE_TYPE, content);
}

/** Enabled daily notification content facets. */
export function enabledDailyNotificationFacets(
	prefs: readonly PrefRow[],
): Set<DailyNotificationContent> {
	return enabledFacets(prefs, DAILY_NOTIFICATION_PREFERENCE_TYPE) as Set<DailyNotificationContent>;
}

/** True when any daily notification facet is enabled. */
export function hasAnyDailyNotificationFacet(prefs: readonly PrefRow[]): boolean {
	return anyFacetEnabled(prefs, DAILY_NOTIFICATION_PREFERENCE_TYPE);
}

/** True when this account should receive a human daily digest. */
export function userHasHumanDailyDigest(user: {
	daily_notification_enabled: boolean;
	prefs: readonly PrefRow[];
}): boolean {
	return user.daily_notification_enabled && hasAnyDailyNotificationFacet(user.prefs);
}

/** True when any asset-event facet is enabled. */
export function hasAnyDailyAssetEventFacet(prefs: readonly PrefRow[]): boolean {
	for (const content of DAILY_ASSET_EVENT_FACETS) {
		if (isDailyNotificationFacetEnabled(prefs, content)) {
			return true;
		}
	}
	return false;
}
