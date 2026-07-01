import type { AlertMoveSize } from "../db/types";
import type { PrefRow } from "../messaging/notification-prefs";

export interface AssetSnapshot {
	symbol: string;
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	volume: number | null;
	capturedAt: string;
}

export interface PriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
	logFailures: number;
}

export interface PriceAlertUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	email_notifications_enabled: boolean;
	market_asset_price_alert_move_size: AlertMoveSize;
	use_24_hour_time: boolean;
	/** Linked Telegram chat (null when never linked); gates the Telegram delivery branch. */
	telegram_chat_id: number | null;
	/** True after a verified outbound 403 ("bot blocked"); suppresses Telegram delivery. */
	telegram_opted_out: boolean;
	/** Per-option channel preferences (single source of truth for all channels). */
	prefs: PrefRow[];
}
