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

import type {
	AssetEventsContent,
	DailyDigestContent,
	FacetlessContent,
	FacetlessNotificationType,
	NotificationPreferenceType,
	PrefChannel,
	PrefRow,
} from "../notification-preference-types";

export type {
	AssetEventsContent,
	DailyDigestContent,
	FacetlessContent,
	NotificationPreferenceType,
	PrefChannel,
	PrefRow,
} from "../notification-preference-types";

const NOTIFICATION_PREFERENCE_TYPES = [
	"daily_digest",
	"asset_events",
	"market_asset_price_alerts",
	"market_scheduled_asset_price",
	"price_move_alerts",
	"price_targets",
] as const satisfies readonly NotificationPreferenceType[];

const DAILY_DIGEST_CONTENTS = [
	"prices",
	"top_movers",
	"news",
	"rumors",
] as const satisfies readonly DailyDigestContent[];

const ASSET_EVENTS_CONTENTS = [
	"calendar",
	"ipo",
	"analyst",
	"insider",
] as const satisfies readonly AssetEventsContent[];

const FACETLESS_NOTIFICATION_TYPES = [
	"market_asset_price_alerts",
	"market_scheduled_asset_price",
	"price_move_alerts",
	"price_targets",
] as const satisfies readonly FacetlessNotificationType[];

const PREF_CHANNELS = ["email", "sms", "telegram"] as const satisfies readonly PrefChannel[];

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

	if (row.notification_type === "daily_digest") {
		if (!(DAILY_DIGEST_CONTENTS as readonly string[]).includes(row.content)) {
			return null;
		}
		return {
			...base,
			notification_type: "daily_digest",
			content: row.content as DailyDigestContent,
		};
	}

	if (row.notification_type === "asset_events") {
		if (!(ASSET_EVENTS_CONTENTS as readonly string[]).includes(row.content)) {
			return null;
		}
		return {
			...base,
			notification_type: "asset_events",
			content: row.content as AssetEventsContent,
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

/* =============
Facet catalog: the canonical set of (notification_type, content, channel) options,
with the DEFAULT value a brand-new user gets. This drives signup defaults, the
dashboard ⇆ table translation, and the seed. It is the authored replacement for
the dropped column DEFAULTs.

Defaults (from the dropped column DEFAULTs):
  daily_digest prices email = true, daily_digest prices sms = true
  ALL OTHER facet rows = false
News/rumors are email + telegram only (no sms facet ever existed for them).
============= */

/** One catalog entry: a (type, content, channel) option and its new-user default. */
type FacetCatalogEntry = {
	notification_type: NotificationPreferenceType;
	content: DailyDigestContent | AssetEventsContent | FacetlessContent;
	channel: PrefChannel;
	default: boolean;
};

export const NOTIFICATION_PREFERENCE_CATALOG: readonly FacetCatalogEntry[] = [
	// daily_digest
	{
		notification_type: "daily_digest",
		content: "prices",
		channel: "email",
		default: true,
	},
	{
		notification_type: "daily_digest",
		content: "prices",
		channel: "sms",
		default: true,
	},
	{
		notification_type: "daily_digest",
		content: "prices",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_digest",
		content: "top_movers",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_digest",
		content: "top_movers",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "daily_digest",
		content: "top_movers",
		channel: "telegram",
		default: false,
	},
	// news/rumors: email + telegram only
	{
		notification_type: "daily_digest",
		content: "news",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_digest",
		content: "news",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_digest",
		content: "rumors",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_digest",
		content: "rumors",
		channel: "telegram",
		default: false,
	},
	// asset_events
	{
		notification_type: "asset_events",
		content: "calendar",
		channel: "email",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "calendar",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "calendar",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "ipo",
		channel: "email",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "ipo",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "ipo",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "analyst",
		channel: "email",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "analyst",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "analyst",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "insider",
		channel: "email",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "insider",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "asset_events",
		content: "insider",
		channel: "telegram",
		default: false,
	},
	// facet-less market/price types (content = "")
	{
		notification_type: "market_asset_price_alerts",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "market_asset_price_alerts",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "market_asset_price_alerts",
		content: "",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "market_scheduled_asset_price",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "market_scheduled_asset_price",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "market_scheduled_asset_price",
		content: "",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "price_move_alerts",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "price_move_alerts",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "price_move_alerts",
		content: "",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "price_targets",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "price_targets",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "price_targets",
		content: "",
		channel: "telegram",
		default: false,
	},
] as const;

/** Build the full set of default preference rows for a brand-new user. */
export function buildDefaultPreferenceRows(userId: string): Array<{
	user_id: string;
	notification_type: NotificationPreferenceType;
	content: DailyDigestContent | AssetEventsContent | FacetlessContent;
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
	content: DailyDigestContent | AssetEventsContent | FacetlessContent = "",
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
): Set<DailyDigestContent | AssetEventsContent | FacetlessContent> {
	const facets = new Set<DailyDigestContent | AssetEventsContent | FacetlessContent>();
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
