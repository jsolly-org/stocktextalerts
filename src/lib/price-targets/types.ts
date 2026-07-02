import type { PriceTargetDirection } from "../db";
import type { PrefRow } from "../types";

export interface PriceTargetUser {
	id: string;
	email: string;
	/** Global per-user email kill-switch; gates the email delivery branch. */
	email_notifications_enabled: boolean;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	/** Linked Telegram chat (null when never linked); gates the Telegram delivery branch. */
	telegram_chat_id: number | null;
	/** True after a verified outbound 403 ("bot blocked"); suppresses Telegram delivery. */
	telegram_opted_out: boolean;
	/** Per-option channel preferences (single source of truth for all channels). */
	prefs: PrefRow[];
}

export interface TriggeredPriceTarget {
	symbol: string;
	targetPrice: number;
	currentPrice: number;
	direction: PriceTargetDirection;
	iconUrl?: string | null;
	iconBase64?: string | null;
}

/** Per-run delivery counters for price target notifications. */
export interface PriceTargetDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
	logFailures: number;
}

export interface PriceTargetTotals extends PriceTargetDeliveryStats {
	targetsChecked: number;
	targetsTriggered: number;
	/** Times `deliverPriceTargetAlert` threw (a hard delivery failure), distinct
	 *  from `logFailures` (a `notification_log` insert failure on an otherwise
	 *  successful or normally-failed send). */
	deliveryErrors: number;
}

/** Outcome of one channel in a single delivery round. `skipped` means the channel
 *  was not attempted (not wanted, not usable, or already delivered on a prior round). */
type PriceTargetChannelOutcome = "sent" | "failed" | "skipped";

/** Per-channel outcome of one `deliverPriceTargetAlert` round. The caller uses this
 *  to decide when every *required* channel has reached a terminal (sent) state. */
export interface PriceTargetDeliveryOutcome {
	email: PriceTargetChannelOutcome;
	sms: PriceTargetChannelOutcome;
	telegram: PriceTargetChannelOutcome;
}
