/**
 * Shared notification-footer strings.
 *
 * Personal-app footer (2026-07): notifications no longer carry a "not financial advice"
 * disclaimer — StockTextAlerts is a private two-person household app, not a public advisory
 * service. SMS keeps the carrier-mandated opt-out line; Telegram keeps a hint for its real
 * /stop command. These constants are the single source so the channels never drift.
 */

/** SMS / plaintext opt-out line. Carrier A2P requirement — stays on SMS regardless of audience. */
export const SMS_OPT_OUT = "Reply STOP to opt out.";

/** Telegram footer: a hint for the real `/stop` bot command that pauses alerts
 *  (see src/pages/api/messaging/telegram.ts), so it's an actionable affordance, not compliance copy. */
export const TELEGRAM_FOOTER = "Send /stop to pause alerts.";
