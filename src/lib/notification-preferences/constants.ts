import type { NotificationOptionFieldName } from "../constants";
import {
	NOTIFICATION_PREFERENCE_CATALOG,
	USER_SELECTABLE_DELIVERY_CHANNEL_MODES,
} from "../constants";
import type { FormSchema } from "../forms/schema";

/** One boolean form field per catalog option, derived from the option matrix. */
const OPTION_BOOLEAN_FIELDS = Object.fromEntries(
	NOTIFICATION_PREFERENCE_CATALOG.map((entry) => [entry.fieldName, { type: "boolean" }]),
) as Record<NotificationOptionFieldName, { type: "boolean" }>;

/** Form schema for the notification-preferences update route. Per-option content
 *  fields derive from NOTIFICATION_PREFERENCE_CATALOG; only the `users`-column
 *  fields below are authored here. `lambda` is excluded — service/provision only. */
export const NOTIFICATION_PREFERENCES_SCHEMA = {
	market_scheduled_asset_price_enabled: { type: "boolean" },
	delivery_channel: { type: "enum", values: USER_SELECTABLE_DELIVERY_CHANNEL_MODES },
	timezone: { type: "timezone" },
	market_scheduled_asset_price_times: { type: "json_string_array" },
	daily_digest_time: { type: "time" },
	...OPTION_BOOLEAN_FIELDS,
} as const satisfies FormSchema;
