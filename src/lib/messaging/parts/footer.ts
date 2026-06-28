/**
 * Shared notification-footer strings.
 *
 * Per-channel footer contract (audit fmt-4): EVERY channel's footer carries BOTH a
 * "not financial advice" disclaimer AND an opt-out/manage path. These constants are the
 * single source so SMS, email, and Telegram never drift on the wording again.
 */

/** Disclaimer line carried by every channel's footer. */
export const NOT_FINANCIAL_ADVICE = "Not financial advice.";

/** SMS / plaintext opt-out line. */
export const SMS_OPT_OUT = "Reply STOP to opt out.";

/** Telegram footer: disclaimer + opt-out hint. `/stop` is a real bot command that pauses
 *  alerts (see src/pages/api/messaging/telegram.ts), so the hint is actionable. */
export const TELEGRAM_FOOTER = `${NOT_FINANCIAL_ADVICE} Send /stop to pause alerts.`;
