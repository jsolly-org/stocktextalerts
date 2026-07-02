/* =============
Canonical notification-preference model.

`notification_preferences` is the single source of truth for ALL channels
(email, sms, telegram). One row per (user_id, notification_type, content, channel).
`content = ""` for facet-less notification types (the market/price types).

This module replaces the wall of per-option `*_include_{email,sms}` columns that
used to live on `public.users`. Channels are uniform peers — adding one is just
rows, not schema. The eligibility helpers below are channel-parametric (the old
telegram-only helpers generalized): a channel is "wanted" for a type when its
global enable is on AND at least one facet row is enabled for (type, channel).
============= */

import { PREF_CHANNELS } from "../constants";
import type {
	DailyNotificationContent,
	FacetlessContent,
	FacetlessNotificationType,
	NotificationPreferenceType,
	PrefChannel,
	PrefRow,
} from "../types";
import { NOTIFICATION_PREFERENCE_CATALOG } from "./constants";

const NOTIFICATION_PREFERENCE_TYPES = [
	"daily_notification",
	"market_asset_price_alerts",
	"market_scheduled_asset_price",
	"price_move_alerts",
	"price_targets",
] as const satisfies readonly NotificationPreferenceType[];

const DAILY_NOTIFICATION_CONTENTS = [
	"prices",
	"top_movers",
	"news",
	"rumors",
	"calendar",
	"ipo",
	"analyst",
	"insider",
] as const satisfies readonly DailyNotificationContent[];

const FACETLESS_NOTIFICATION_TYPES = [
	"market_asset_price_alerts",
	"market_scheduled_asset_price",
	"price_move_alerts",
	"price_targets",
] as const satisfies readonly FacetlessNotificationType[];

function isNotificationPreferenceType(value: string): value is NotificationPreferenceType {
	return (NOTIFICATION_PREFERENCE_TYPES as readonly string[]).includes(value);
}

function isPrefChannel(value: string): value is PrefChannel {
	return (PREF_CHANNELS as readonly string[]).includes(value);
}

/** Parse a DB/API preference row; null when type/content/channel is invalid. */
export function parsePrefRow(row: {
	notification_type: string;
	content: string;
	channel: string;
	enabled: boolean;
}): PrefRow | null {
	if (!isNotificationPreferenceType(row.notification_type) || !isPrefChannel(row.channel)) {
		return null;
	}

	const base = { channel: row.channel, enabled: row.enabled };

	if (row.notification_type === "daily_notification") {
		if (!(DAILY_NOTIFICATION_CONTENTS as readonly string[]).includes(row.content)) {
			return null;
		}
		return {
			...base,
			notification_type: "daily_notification",
			content: row.content as DailyNotificationContent,
		};
	}

	if (!(FACETLESS_NOTIFICATION_TYPES as readonly string[]).includes(row.notification_type)) {
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
	channel: PrefChannel;
	enabled: boolean;
}> {
	return NOTIFICATION_PREFERENCE_CATALOG.map((entry) => ({
		user_id: userId,
		notification_type: entry.notification_type,
		content: entry.content,
		channel: entry.channel,
		enabled: entry.default,
	}));
}

/* ============= Eligibility helpers (channel-parametric) ============= */

/**
 * True when a specific facet is enabled for a channel.
 * `content` defaults to "" for facet-less notification types.
 */
export function isFacetEnabled(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
	channel: PrefChannel,
	content: DailyNotificationContent | FacetlessContent = "",
): boolean {
	return prefs.some(
		(p) =>
			p.notification_type === notificationType &&
			p.channel === channel &&
			p.content === content &&
			p.enabled,
	);
}

/**
 * The set of content facets enabled for a channel for a given notification type
 * (e.g. {"prices","top_movers"} for daily_digest email). Facet-less types use "".
 */
export function enabledFacets(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
	channel: PrefChannel,
): Set<DailyNotificationContent | FacetlessContent> {
	const facets = new Set<DailyNotificationContent | FacetlessContent>();
	for (const p of prefs) {
		if (p.notification_type === notificationType && p.channel === channel && p.enabled) {
			facets.add(p.content);
		}
	}
	return facets;
}

/** True when at least one facet is enabled for (type, channel). */
export function anyFacetEnabled(
	prefs: readonly PrefRow[],
	notificationType: NotificationPreferenceType,
	channel: PrefChannel,
): boolean {
	return prefs.some(
		(p) => p.notification_type === notificationType && p.channel === channel && p.enabled,
	);
}

/** True when at least one SMS facet is enabled across ANY notification type EXCEPT
 *  `price_targets`. This mirrors the legacy `shouldSendSms` feature-gate: enabling
 *  only price-target SMS must not make a user eligible for unrelated flows. */
export function anySmsFacetEnabledExceptPriceTargets(prefs: readonly PrefRow[]): boolean {
	return prefs.some(
		(p) => p.channel === "sms" && p.enabled && p.notification_type !== "price_targets",
	);
}
