import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import type { DeliveryResult } from "../../types";

/** A fully-rendered outbound Telegram message (text carries out-of-band entities). */
export interface TelegramMessage {
	chatId: number | string;
	/** Plain text; formatting travels via `entities`, not parse_mode. */
	text: string;
	/** Entity markers (offset/length) from the parse-mode `fmt` builder. */
	entities?: MessageEntity[];
	/** When present, send as a photo with `text` as the caption (≤1024 chars). */
	photo?: Buffer;
	/** Inline keyboard for actionable alerts. */
	replyMarkup?: InlineKeyboardMarkup;
	/** Silent delivery (e.g. routine digest) — maps to Telegram's disable_notification. */
	disableNotification?: boolean;
}

export type TelegramSender = (message: TelegramMessage) => Promise<DeliveryResult>;

interface TelegramSenderResult {
	sender: TelegramSender;
}

export type TelegramSenderFactory = () => TelegramSenderResult;
