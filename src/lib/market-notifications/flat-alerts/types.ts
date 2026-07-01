import type { PrefRow } from "../../messaging/notification-prefs";

/** Minimal user shape for flat price alert delivery across email + SMS + Telegram. */
export interface FlatPriceAlertUser {
	id: string;
	email: string;
	email_notifications_enabled: boolean;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	use_24_hour_time: boolean;
	/** Linked Telegram chat (null when never linked); gates the Telegram delivery branch. */
	telegram_chat_id: number | null;
	/** True after a verified outbound 403 ("bot blocked"); suppresses Telegram delivery. */
	telegram_opted_out: boolean;
	/** Per-option channel preferences (single source of truth for all channels). */
	prefs: PrefRow[];
}

/** Per-run delivery counters. */
export interface FlatPriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
	logFailures: number;
}
