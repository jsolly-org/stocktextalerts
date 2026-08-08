/* =============
Canonical notification-preference model.

`notification_preferences` is the single source of truth for content toggles.
One row per (user_id, notification_type, content). Account routing lives on
`users.delivery_channel` (email | telegram | disabled), not on each option.
`content = ""` for facet-less notification types (the market/price types).
============= */

import type {
	DailyNotificationContent,
	FacetlessContent,
	FacetlessNotificationType,
	NotificationPreferenceType,
} from "../constants";
import { NOTIFICATION_OPTION_MATRIX, NOTIFICATION_PREFERENCE_CATALOG } from "../constants";
import type { PrefRow } from "../types";

// Validation lists derived from the authored option matrix (single source).
const NOTIFICATION_PREFERENCE_TYPES = Object.keys(
	NOTIFICATION_OPTION_MATRIX,
) as readonly NotificationPreferenceType[];

const DAILY_NOTIFICATION_CONTENTS = Object.keys(
	NOTIFICATION_OPTION_MATRIX.daily_notification,
) as readonly DailyNotificationContent[];

const FACETLESS_NOTIFICATION_TYPES = NOTIFICATION_PREFERENCE_TYPES.filter(
	(type): type is FacetlessNotificationType => type !== "daily_notification",
);

function isNotificationPreferenceType(value: string): value is NotificationPreferenceType {
	return (NOTIFICATION_PREFERENCE_TYPES as readonly string[]).includes(value);
}

function isDailyNotificationContent(value: string): value is DailyNotificationContent {
	return (DAILY_NOTIFICATION_CONTENTS as readonly string[]).includes(value);
}

function isFacetlessNotificationType(value: string): value is FacetlessNotificationType {
	return (FACETLESS_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** Parse a DB/API preference row; null when type/content is invalid. */
export function parsePrefRow(row: {
	notification_type: string;
	content: string;
	enabled: boolean;
}): PrefRow | null {
	if (!isNotificationPreferenceType(row.notification_type)) {
		return null;
	}

	const base = { enabled: row.enabled };

	if (row.notification_type === "daily_notification") {
		if (!isDailyNotificationContent(row.content)) {
			return null;
		}
		return {
			...base,
			notification_type: "daily_notification",
			content: row.content,
		};
	}

	if (!isFacetlessNotificationType(row.notification_type)) {
		return null;
	}
	if (row.content !== "") {
		return null;
	}

	return {
		...base,
		notification_type: row.notification_type,
		content: "",
	};
}

/** Build the full set of default preference rows for a brand-new user. */
export function buildDefaultPreferenceRows(userId: string): Array<{
	user_id: string;
	notification_type: NotificationPreferenceType;
	content: DailyNotificationContent | FacetlessContent;
	enabled: boolean;
}> {
	return NOTIFICATION_PREFERENCE_CATALOG.map((entry) => ({
		user_id: userId,
		notification_type: entry.notification_type,
		content: entry.content,
		enabled: entry.default,
	}));
}

/* ============= Eligibility helpers ============= */

/**
 * True when a specific facet is enabled.
 * `content` defaults to "" for facet-less notification types.
 */
export function isFacetEnabled(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
	content: DailyNotificationContent | FacetlessContent = "",
): boolean {
	return prefs.some(
		(p) => p.notification_type === notificationType && p.content === content && p.enabled,
	);
}

/**
 * The set of content facets enabled for a given notification type
 * (e.g. {"prices","top_movers"} for daily_notification). Facet-less types use "".
 */
export function enabledFacets(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
): Set<DailyNotificationContent | FacetlessContent> {
	const facets = new Set<DailyNotificationContent | FacetlessContent>();
	for (const p of prefs) {
		if (p.notification_type === notificationType && p.enabled) {
			facets.add(p.content);
		}
	}
	return facets;
}

/** True when at least one facet is enabled for a notification type. */
export function anyFacetEnabled(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
): boolean {
	return prefs.some((p) => p.notification_type === notificationType && p.enabled);
}
