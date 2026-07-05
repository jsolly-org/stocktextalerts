/**
 * Shared notification-footer strings.
 *
 * Personal-app footer (2026-07): notifications no longer carry a "not financial advice"
 * disclaimer — StockTextAlerts is a private two-person household app, not a public advisory
 * service. Telegram keeps a hint for its real /stop command. These constants are the
 * single source so the channels never drift.
 */

/** Telegram footer: a hint for the real `/stop` bot command that pauses alerts
 *  (see src/pages/api/messaging/telegram.ts), so it's an actionable affordance, not compliance copy. */
export const TELEGRAM_FOOTER = "Send /stop to pause alerts.";
