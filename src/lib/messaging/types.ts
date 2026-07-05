import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import type { Database } from "../db/generated/database.types";
import type { TopMover } from "../market-data/types";
import type { MarketClosureInfo } from "../time/types";
import type { DeliveryResult } from "../types";
import type { SparklineData } from "./parts/sparkline";

/** Structured market-wide top movers — raw data each channel renders itself. */
export type TopMoversData = {
	gainers: TopMover[];
	losers: TopMover[];
};

export interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
	idempotencyKey?: string;
	replyTo?: string;
	userId?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;

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

/** Optional Grok/Massive/Finnhub extras appended to digest or scheduled notifications. */
export type NotificationExtras = {
	news?: string | null;
	rumors?: string | null;
	analyst?: string | null;
	insider?: string | null;
	topMovers?: TopMoversData | null;
	citations?: string[];
};

/** Minimal user shape needed to send email. */
export type EmailUser = Pick<Database["public"]["Tables"]["users"]["Row"], "id" | "email">;

/** Optional context for email rendering: sparklines, logos, market closure banners. */
export interface EmailFormatContext {
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
	marketClosureInfo?: MarketClosureInfo | null;
	getLogoHtml?: (symbol: string) => string | undefined;
}
