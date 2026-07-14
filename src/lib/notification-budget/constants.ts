/** Per-user America/New_York calendar-day product notification volume caps.
 *  Must stay in sync with try_consume_notification_budget in
 *  supabase/migrations/*_notification_send_budget.sql. */
export const NOTIFICATION_BUDGET_GLOBAL_DAILY = 40;
export const NOTIFICATION_BUDGET_PRICE_MOVE_DAILY = 20;

/** Budget kinds accepted by try_consume / release_notification_budget. */
export type NotificationBudgetKind =
	| "price_move_alerts"
	| "market_scheduled_asset_price"
	| "daily_notification";
