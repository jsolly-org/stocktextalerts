import type { FacetCatalogEntry, NotificationOptionFieldName } from "../constants";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../constants";
import { Constants } from "../db/generated/database.types";
import type { EmailSmsOptionFieldName } from "../db/types";
import type { FormSchema } from "../forms/schema";

/** One boolean form field per catalog option, derived from the option matrix. */
const OPTION_BOOLEAN_FIELDS = Object.fromEntries(
	NOTIFICATION_PREFERENCE_CATALOG.map((entry) => [entry.fieldName, { type: "boolean" }]),
) as Record<NotificationOptionFieldName, { type: "boolean" }>;

/** Form schema for the notification-preferences update route. Per-option channel
 *  fields derive from NOTIFICATION_PREFERENCE_CATALOG; only the `users`-column
 *  fields below are authored here. */
export const NOTIFICATION_PREFERENCES_SCHEMA = {
	market_scheduled_asset_price_enabled: { type: "boolean" },
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	market_scheduled_asset_price_times: { type: "json_string_array" },
	daily_digest_time: { type: "time" },
	market_asset_price_alerts_enabled: { type: "boolean" },
	market_asset_price_alert_move_size: {
		type: "enum",
		values: Constants.public.Enums.alert_move_size,
	},
	...OPTION_BOOLEAN_FIELDS,
} as const satisfies FormSchema;

/** Every SMS-channel option, used to enforce the sms_opted_out / phone-required
 *  guard against the notification_preferences rows. Derived from the catalog —
 *  the previous hand-kept list silently omitted `daily_digest_include_prices_sms`. */
export const SMS_INCLUDE_OPTIONS: readonly FacetCatalogEntry[] =
	NOTIFICATION_PREFERENCE_CATALOG.filter((entry) => entry.channel === "sms");

/** The form-field names of every SMS option (dashboard "any SMS feature on" checks). */
export const SMS_OPTION_FIELD_NAMES = SMS_INCLUDE_OPTIONS.map(
	(entry) => entry.fieldName,
) as readonly EmailSmsOptionFieldName[];
